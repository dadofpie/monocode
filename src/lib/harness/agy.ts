import { nativeModelId } from "../models";
import type { RuntimeMode } from "../session";
import {
  killChild,
  resolveAgyBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  buildAgySpawnArgs,
  agyStepUpdate,
  agyEventName,
  agyExitError,
  agyPreviewFromTool,
  agyToolTitle,
  formatAgyErrorMessage,
  isAgyTransientNetworkError,
  parseAgyLine,
  resultStatusFromAgy,
  sessionIdFromAgyLine,
  strField,
  summarizeAgyTool,
  toolKindFromAgyName,
  toolRefFromAgyStep,
  type AgyToolRef,
} from "./agyProtocol";
import type {
  ApprovalDecision,
  HarnessEvent,
  SendTurnInput,
  SteerTurnInput,
} from "./types";

type OpenTool = {
  name: string;
  title: string;
};

type Live = {
  cwd: string;
  agySessionId?: string;
  runtimeMode: RuntimeMode;
  onEvent: (event: HarnessEvent) => void;
  openTools: Map<string, OpenTool>;
  cancelled: boolean;
  muteUpdates: boolean;
  turnSettled: boolean;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  stderrTail: string[];
  turns: Promise<void>;
  started: boolean;
  toolsCompleted: number;
};

type Resume = {
  sessionId: string;
  cwd: string;
};

/** Watchdog: a wedged `cmd -p` child must not park a turn forever. */
const TURN_TIMEOUT_MS = 30 * 60_000;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

let resolveAgyBinaryImpl: () => Promise<{ path: string }> = resolveAgyBinary;

/** Test seam. */
export function setAgyBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveAgyBinaryImpl = fn;
}

/**
 * Live Antigravity adapter. Each turn spawns one `cmd -p` child and streams
 * its NDJSON frames until the final result line; follow-ups resume via
 * `--resume <providerSessionId>`.
 */
export async function sendAgyTurn(input: SendTurnInput): Promise<void> {
  const live = ensureAgyLive(input);
  if (cancelledThreads.delete(input.sessionId)) return;
  live.turns = live.turns.catch(() => undefined).then(() => runAgyTurn(live, input));
  await live.turns;
}

export async function steerAgyTurn(_input: SteerTurnInput): Promise<void> {
  throw new Error("Antigravity does not support steering an in-flight turn");
}

/** `--yolo`/`--auto-accept` pre-authorize, so approvals never park a turn. */
export function respondAgyApproval(
  _sessionId: string,
  _requestId: number,
  _decision: ApprovalDecision,
): void {}

export async function cancelAgyTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  await killChild(sessionId).catch(() => undefined);
  settleTurn(live);
}

export async function stopAgySession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  liveByThread.delete(sessionId);
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetAgySession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopAgySession(sessionId);
}

export function bindAgySession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd });
}

function ensureAgyLive(input: SendTurnInput): Live {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    void stopAgySession(input.sessionId);
  }
  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }
  const live: Live = {
    cwd: input.cwd,
    agySessionId: canResume && resume ? resume.sessionId : undefined,
    runtimeMode: input.runtimeMode,
    onEvent: input.onEvent,
    openTools: new Map(),
    cancelled: false,
    muteUpdates: false,
    turnSettled: false,
    turnDone: null,
    turnFailed: null,
    stderrTail: [],
    turns: Promise.resolve(),
    started: false,
    toolsCompleted: 0,
  };
  liveByThread.set(input.sessionId, live);
  return live;
}

const MAX_NETWORK_RETRIES = 2;

async function runAgyTurn(live: Live, input: SendTurnInput): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await runAgyTurnOnce(live, input);
      return;
    } catch (error) {
      if (live.cancelled) return;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const isTransient = isAgyTransientNetworkError(rawMessage);
      const canRetry =
        isTransient && live.toolsCompleted === 0 && attempt <= MAX_NETWORK_RETRIES;

      if (canRetry) {
        const delayMs = attempt * 1500;
        const isSocket =
          rawMessage.includes("can't assign") || rawMessage.includes("eaddrnotavail");
        live.onEvent({
          type: "status",
          text: `Antigravity ${isSocket ? "socket unavailable" : "connection dropped"}; retrying in ${Math.round(delayMs / 1000)}s…`,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        if (live.cancelled) return;
        continue;
      }

      const formatted = formatAgyErrorMessage(rawMessage);
      live.onEvent({ type: "session.error", message: formatted });
      throw new Error(formatted);
    }
  }
}

async function runAgyTurnOnce(live: Live, input: SendTurnInput): Promise<void> {
  const { path } = await resolveAgyBinaryImpl();
  live.cancelled = false;
  live.muteUpdates = false;
  live.turnSettled = false;
  live.openTools.clear();
  live.stderrTail = [];
  live.toolsCompleted = 0;

  if (!live.started) {
    live.started = true;
    live.onEvent({ type: "session.started" });
  }

  const args = buildAgySpawnArgs({
    text: input.text,
    attachments: input.attachments,
    model: nativeModelId(input.model),
    effort: input.modelSettings?.effort,
    resume: live.agySessionId,
    runtimeMode: input.runtimeMode,
  });

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });

  const watchdog = setTimeout(() => {
    if (live.turnSettled) return;
    live.turnFailed?.(new Error("Antigravity turn timed out."));
    live.turnDone = null;
    live.turnFailed = null;
    void killChild(input.sessionId).catch(() => undefined);
  }, TURN_TIMEOUT_MS);

  watchChild(
    input.sessionId,
    (line) => handleLine(input.sessionId, live, line),
    (code) => {
      // Clean exit after the result line is the normal one-shot ending.
      if (live.turnSettled || liveByThread.get(input.sessionId) !== live) return;
      if (live.cancelled) {
        settleTurn(live);
        return;
      }
      const error = agyExitError(code, live.stderrTail.join("\n"));
      live.turnFailed?.(error);
      live.turnDone = null;
      live.turnFailed = null;
    },
    (line) => {
      live.stderrTail.push(line);
      if (live.stderrTail.length > 10) live.stderrTail.shift();
    },
  );

  try {
    await spawnChild(input.sessionId, path, args, input.cwd);
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    throw error;
  } finally {
    clearTimeout(watchdog);
    live.turnDone = null;
    live.turnFailed = null;
    unwatchChild(input.sessionId);
    await killChild(input.sessionId).catch(() => undefined);
  }
}

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseAgyLine(line);
  if (!rec || live.muteUpdates) return;

  bindProviderSession(sessionId, live, rec);

  if (agyEventName(rec) === "result") {
    handleResult(sessionId, live, rec);
    return;
  }
  if (agyEventName(rec) === "init") return;

  const step = agyStepUpdate(rec);
  if (!step) return;

  const stepType = strField(step, "step_type");
  const state = strField(step, "state").toUpperCase();
  const delta = strField(step, "text_delta");
  if (delta && (stepType === "agent_response" || stepType === "assistant")) {
    live.onEvent({ type: "message.delta", text: delta });
  }

  if (stepType !== "tool") return;
  const ref = toolRefFromAgyStep(step);
  if (!ref) return;
  if (state === "ACTIVE" || state === "RUNNING") {
    const title = agyToolTitle(ref.name, ref.input);
    live.openTools.set(ref.callId, { name: ref.name, title });
    live.onEvent({
      type: "tool.started",
      callId: ref.callId,
      title,
      kind: toolKindFromAgyName(ref.name),
      status: "in_progress",
      preview: agyPreviewFromTool(ref.name, ref.input),
    });
    return;
  }
  if (state === "DONE" || state === "COMPLETED" || state === "ERROR") {
    finishOpenTool(
      live,
      ref,
      state === "ERROR" ? "failed" : "completed",
    );
  }
}

function finishOpenTool(
  live: Live,
  ref: AgyToolRef,
  status: string,
  detail?: string,
): void {
  live.toolsCompleted++;
  const open = live.openTools.get(ref.callId);
  live.openTools.delete(ref.callId);
  live.onEvent({
    type: "tool.updated",
    callId: ref.callId,
    title: open?.title ?? agyToolTitle(ref.name, ref.input),
    kind: toolKindFromAgyName(ref.name),
    status,
    detail: detail ?? summarizeAgyTool(ref.name, ref.input),
    preview: agyPreviewFromTool(ref.name, ref.input),
  });
}

function bindProviderSession(
  sessionId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  const providerId = sessionIdFromAgyLine(rec);
  if (!providerId || providerId === live.agySessionId) return;
  live.agySessionId = providerId;
  resumeByThread.set(sessionId, { sessionId: providerId, cwd: live.cwd });
  live.onEvent({ type: "session.providerBound", providerSessionId: providerId });
}

function handleResult(
  sessionId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  bindProviderSession(sessionId, live, rec);
  const outcome = resultStatusFromAgy(rec);
  if (outcome.status === "failed") {
    live.turnFailed?.(new Error(outcome.error ?? "Antigravity turn failed"));
    live.turnDone = null;
    live.turnFailed = null;
    return;
  }
  for (const [callId, open] of live.openTools) {
    live.openTools.delete(callId);
    live.onEvent({
      type: "tool.updated",
      callId,
      title: open.title,
      kind: toolKindFromAgyName(open.name),
      status: "completed",
    });
  }
  settleTurn(live);
}

/** Resolve the turn promise once; the child exit that follows is expected. */
function settleTurn(live: Live): void {
  if (live.turnSettled) return;
  live.turnSettled = true;
  live.onEvent({ type: "message.completed" });
  live.onEvent({ type: "reasoning.completed" });
  live.turnDone?.();
  live.turnDone = null;
  live.turnFailed = null;
}
