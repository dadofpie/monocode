import { nativeModelId } from "../models";
import type { RuntimeMode } from "../session";
import {
  killChild,
  resolveCmdBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  buildCmdSpawnArgs,
  cmdEvent,
  cmdEventType,
  cmdExitError,
  cmdFrameType,
  cmdPreviewFromTool,
  cmdToolTitle,
  formatCmdErrorMessage,
  isCmdTransientNetworkError,
  parseCmdLine,
  resultStatusFromCmd,
  sessionIdFromCmdLine,
  strField,
  summarizeCmdTool,
  toolKindFromCmdName,
  toolRefFromCmdEvent,
  type CmdToolRef,
} from "./cmdProtocol";
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
  cmdSessionId?: string;
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
const MAX_TURNS_PER_RUN = 100;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

let resolveCmdBinaryImpl: () => Promise<{ path: string }> = resolveCmdBinary;

/** Test seam. */
export function setCmdBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveCmdBinaryImpl = fn;
}

/**
 * Live CommandCode adapter. Each turn spawns one `cmd -p` child and streams
 * its NDJSON frames until the final result line; follow-ups resume via
 * `--resume <providerSessionId>`.
 */
export async function sendCmdTurn(input: SendTurnInput): Promise<void> {
  const live = ensureCmdLive(input);
  if (cancelledThreads.delete(input.sessionId)) return;
  live.turns = live.turns.catch(() => undefined).then(() => runCmdTurn(live, input));
  await live.turns;
}

export async function steerCmdTurn(_input: SteerTurnInput): Promise<void> {
  throw new Error("CommandCode does not support steering an in-flight turn");
}

/** `--yolo`/`--auto-accept` pre-authorize, so approvals never park a turn. */
export function respondCmdApproval(
  _sessionId: string,
  _requestId: number,
  _decision: ApprovalDecision,
): void {}

export async function cancelCmdTurn(sessionId: string): Promise<void> {
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

export async function stopCmdSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  liveByThread.delete(sessionId);
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetCmdSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopCmdSession(sessionId);
}

export function bindCmdSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd });
}

function ensureCmdLive(input: SendTurnInput): Live {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    void stopCmdSession(input.sessionId);
  }
  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }
  const live: Live = {
    cwd: input.cwd,
    cmdSessionId: canResume && resume ? resume.sessionId : undefined,
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

async function runCmdTurn(live: Live, input: SendTurnInput): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await runCmdTurnOnce(live, input);
      return;
    } catch (error) {
      if (live.cancelled) return;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const isTransient = isCmdTransientNetworkError(rawMessage);
      const canRetry =
        isTransient && live.toolsCompleted === 0 && attempt <= MAX_NETWORK_RETRIES;

      if (canRetry) {
        const delayMs = attempt * 1500;
        live.onEvent({
          type: "status",
          text: `CommandCode connection dropped; retrying in ${Math.round(delayMs / 1000)}s…`,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        if (live.cancelled) return;
        continue;
      }

      const formatted = formatCmdErrorMessage(rawMessage);
      live.onEvent({ type: "session.error", message: formatted });
      throw new Error(formatted);
    }
  }
}

async function runCmdTurnOnce(live: Live, input: SendTurnInput): Promise<void> {
  const { path } = await resolveCmdBinaryImpl();
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

  const args = buildCmdSpawnArgs({
    text: input.text,
    attachments: input.attachments,
    model: nativeModelId(input.model),
    effort: input.modelSettings?.effort,
    resume: live.cmdSessionId,
    maxTurns: MAX_TURNS_PER_RUN,
    runtimeMode: input.runtimeMode,
  });

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });

  const watchdog = setTimeout(() => {
    if (live.turnSettled) return;
    live.turnFailed?.(new Error("CommandCode turn timed out."));
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
      const error = cmdExitError(code, live.stderrTail.join("\n"));
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
  const rec = parseCmdLine(line);
  if (!rec || live.muteUpdates) return;

  if (cmdFrameType(rec) === "result") {
    handleResult(sessionId, live, rec);
    return;
  }
  if (cmdFrameType(rec) !== "event") return;

  const event = cmdEvent(rec);
  if (!event) return;
  bindProviderSession(sessionId, live, rec);

  switch (cmdEventType(rec)) {
    case "text_delta": {
      const delta = strField(event, "delta");
      if (delta) live.onEvent({ type: "message.delta", text: delta });
      return;
    }
    case "tool_queued": {
      const ref = toolRefFromCmdEvent(event);
      if (!ref) return;
      const title = cmdToolTitle(ref.name, ref.input);
      live.openTools.set(ref.callId, { name: ref.name, title });
      live.onEvent({
        type: "tool.started",
        callId: ref.callId,
        title,
        kind: toolKindFromCmdName(ref.name),
        status: "pending",
        preview: cmdPreviewFromTool(ref.name, ref.input),
      });
      return;
    }
    case "tool_running": {
      const ref = toolRefFromCmdEvent(event);
      if (!ref) return;
      const open = live.openTools.get(ref.callId);
      live.onEvent({
        type: "tool.updated",
        callId: ref.callId,
        title: open?.title ?? cmdToolTitle(ref.name, ref.input),
        kind: toolKindFromCmdName(ref.name),
        status: "in_progress",
        preview: cmdPreviewFromTool(ref.name, ref.input),
      });
      return;
    }
    case "tool_completed": {
      const ref = toolRefFromCmdEvent(event);
      if (!ref) return;
      finishOpenTool(live, ref, "completed");
      return;
    }
    case "tool_hook_blocked": {
      const ref = toolRefFromCmdEvent(event);
      if (!ref) return;
      const detail =
        strField(event, "hookOutput") ||
        "CommandCode blocked this tool in headless mode.";
      finishOpenTool(live, ref, "denied", detail);
      return;
    }
    default:
      return;
  }
}

function finishOpenTool(
  live: Live,
  ref: CmdToolRef,
  status: string,
  detail?: string,
): void {
  live.toolsCompleted++;
  const open = live.openTools.get(ref.callId);
  live.openTools.delete(ref.callId);
  live.onEvent({
    type: "tool.updated",
    callId: ref.callId,
    title: open?.title ?? cmdToolTitle(ref.name, ref.input),
    kind: toolKindFromCmdName(ref.name),
    status,
    detail: detail ?? summarizeCmdTool(ref.name, ref.input),
    preview: cmdPreviewFromTool(ref.name, ref.input),
  });
}

function bindProviderSession(
  sessionId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  const providerId = sessionIdFromCmdLine(rec);
  if (!providerId || providerId === live.cmdSessionId) return;
  live.cmdSessionId = providerId;
  resumeByThread.set(sessionId, { sessionId: providerId, cwd: live.cwd });
  live.onEvent({ type: "session.providerBound", providerSessionId: providerId });
}

function handleResult(
  sessionId: string,
  live: Live,
  rec: Record<string, unknown>,
): void {
  bindProviderSession(sessionId, live, rec);
  const outcome = resultStatusFromCmd(rec);
  if (outcome.status === "failed") {
    live.turnFailed?.(new Error(outcome.error ?? "CommandCode turn failed"));
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
      kind: toolKindFromCmdName(open.name),
      status: "completed",
    });
  }
  if (outcome.maxTurns) {
    live.onEvent({ type: "status", text: "Hit the turn limit — partial results." });
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
