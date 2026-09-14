import type { AgentModel, ModelSetting } from "../models";
import type { Attachment, RuntimeMode, ToolPreview } from "../session";
import { attachmentPathText } from "../attachments";
import { extractToolPreview, titleFromToolInput } from "./preview";

/**
 * CommandCode (`cmd`) headless protocol.
 *
 * Each turn spawns `cmd -p <text> --output-format json …` and reads NDJSON
 * frames from stdout:
 *   {"type":"event","event":{"type":"tool_running",…}}  — progress frames
 *   {"type":"result","subtype":"success",…}              — always last
 *
 * Observed event types (unknown ones are ignored — the format is explicitly
 * forward-compatible): run_start, turn_start, message_start,
 * model_request_start, model_trace, text_delta, message_update,
 * model_request_end, message_end, tool_queued, tool_running, tool_completed,
 * tool_hook_blocked, turn_end, run_end.
 */

export type CmdSpawnInput = {
  text: string;
  model?: string;
  effort?: string;
  resume?: string;
  maxTurns?: number;
  runtimeMode: RuntimeMode;
  /** Helper calls (titles, commit messages): no persistence, no onboarding. */
  noSession?: boolean;
  attachments?: Attachment[];
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function strField(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  return typeof value === "string" ? value : "";
}

/** Parse one stdout line; null when it is not a JSON object (progress text). */
export function parseCmdLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Top-level frame: "event" | "result" | null. */
export function cmdFrameType(rec: Record<string, unknown>): string | null {
  const type = strField(rec, "type");
  return type === "event" || type === "result" ? type : null;
}

export function cmdEvent(rec: Record<string, unknown>): Record<string, unknown> | null {
  if (cmdFrameType(rec) !== "event") return null;
  return asRecord(rec.event);
}

export function cmdEventType(rec: Record<string, unknown>): string {
  const event = cmdEvent(rec);
  return event ? strField(event, "type") : "";
}

/**
 * Permission flags per runtime mode. Headless `cmd` has no UI to answer
 * prompts, so anything but supervised must pre-authorize writes/shell:
 * auto modes accept prompts, full-access bypasses them entirely.
 */
export function cmdModeArgs(runtimeMode: RuntimeMode): string[] {
  switch (runtimeMode) {
    case "auto-accept-edits":
    case "auto":
      return ["--auto-accept"];
    case "full-access":
      return ["--yolo"];
    case "supervised":
    default:
      return [];
  }
}

export function buildCmdSpawnArgs(input: CmdSpawnInput): string[] {
  const args = ["-p", cmdPromptWithAttachments(input), "--output-format", "json"];
  if (input.noSession) {
    args.push("--no-session");
  } else if (input.resume) {
    args.push("--resume", input.resume);
  }
  args.push("--skip-onboarding", "--trust");
  args.push(...cmdModeArgs(input.runtimeMode));
  const model = input.model?.trim();
  if (model) args.push("--model", model);
  const effort = input.effort?.trim();
  if (effort) args.push("--effort", effort);
  if (input.maxTurns && input.maxTurns > 0) {
    args.push("--max-turns", String(Math.floor(input.maxTurns)));
  }
  return args;
}

/** `cmd -p` takes a single prompt string, so attachments ride along as path lines. */
export function cmdPromptWithAttachments(input: {
  text: string;
  attachments?: Attachment[];
}): string {
  const paths = (input.attachments ?? []).map((attachment) =>
    attachmentPathText(attachment),
  );
  return [input.text, ...paths].filter((part) => part.trim()).join("\n\n");
}

export function sessionIdFromCmdLine(rec: Record<string, unknown>): string | undefined {
  const event = cmdEvent(rec);
  if (event) {
    const id = strField(event, "sessionId");
    if (id) return id;
    const result = asRecord(event.result);
    if (result) {
      const nested = strField(result, "sessionId");
      if (nested) return nested;
      const next = asRecord(result.nextState);
      const nextId = next ? strField(next, "sessionId") : "";
      if (nextId) return nextId;
    }
  }
  if (cmdFrameType(rec) === "result") {
    const id = strField(rec, "sessionId");
    if (id) return id;
  }
  return undefined;
}

export type CmdToolRef = {
  callId: string;
  name: string;
  input: Record<string, unknown>;
};

export function toolRefFromCmdEvent(
  event: Record<string, unknown>,
): CmdToolRef | null {
  const callId =
    strField(event, "toolCallId") || strField(event, "id");
  const name = strField(event, "toolName") || strField(event, "name");
  if (!callId || !name) return null;
  return { callId, name, input: asRecord(event.input) ?? {} };
}

export function toolKindFromCmdName(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("powershell") ||
    normalized === "run_command"
  ) {
    return "shell";
  }
  if (normalized === "agent" || normalized.startsWith("agent_")) return "agent";
  if (normalized.startsWith("task_") || normalized === "todo_write") {
    return "task";
  }
  if (normalized === "ask_user_question") return "question";
  if (normalized.includes("edit") || normalized.includes("write")) {
    return "edit";
  }
  if (normalized.includes("read") || normalized.includes("directory")) {
    return "read";
  }
  if (
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search") ||
    normalized.includes("fetch")
  ) {
    return "search";
  }
  return toolName;
}

function previewKindFromCmdName(toolName: string): ToolPreview["kind"] | undefined {
  const kind = toolKindFromCmdName(toolName);
  if (kind === "read") return "read";
  if (kind === "edit") return "write";
  if (kind === "shell") return "shell";
  if (kind === "search") return "search";
  return undefined;
}

export function cmdToolTitle(name: string, input: Record<string, unknown>): string {
  return titleFromToolInput(name, toolKindFromCmdName(name), input);
}

export function cmdPreviewFromTool(
  name: string,
  input: Record<string, unknown>,
): ToolPreview | undefined {
  const kind = previewKindFromCmdName(name);
  if (!kind) return undefined;
  return extractToolPreview(
    { title: name, name, kind, rawInput: input, input },
    { title: name, name, kind, rawInput: input },
  );
}

/** One-line detail for tool.updated rows: path, query, or command. */
export function summarizeCmdTool(
  name: string,
  input: Record<string, unknown>,
): string | undefined {
  const preview = cmdPreviewFromTool(name, input);
  if (preview?.path) return preview.path;
  if (preview?.query) return preview.query;
  for (const key of ["command", "cmd", "pattern", "query", "url", "file_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const first = value.trim().split(/\r?\n/)[0] ?? "";
      if (first) return first.slice(0, 120);
    }
  }
  return undefined;
}

export type CmdResultStatus = {
  status: "completed" | "failed";
  error?: string;
  maxTurns?: boolean;
};

/** Final {"type":"result"} line → turn outcome. */
export function resultStatusFromCmd(rec: Record<string, unknown>): CmdResultStatus {
  const subtype = strField(rec, "subtype");
  if (subtype === "success") return { status: "completed" };
  if (subtype === "max_turns") {
    return { status: "completed", maxTurns: true };
  }
  const error = strField(rec, "error") || "CommandCode turn failed";
  return { status: "failed", error };
}

/**
 * Non-zero exits when no result line arrived. Codes from `cmd --help` /
 * headless docs: 3 auth, 4 permission, 5 rate limit, 6 network, 7 server,
 * 8 max turns, 10 credits, 130 interrupted.
 */
export function cmdExitError(code: number | null, stderrTail: string): Error {
  const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" ").trim();
  const hint = tail ? ` ${tail.slice(0, 240)}` : "";
  switch (code) {
    case 3:
      return new Error(
        `CommandCode is not authenticated. Run \`cmd login\` in a terminal, then retry.${hint}`,
      );
    case 4:
      return new Error(`CommandCode denied permission.${hint}`);
    case 5:
      return new Error(`CommandCode rate limit exceeded.${hint}`);
    case 6:
      return new Error(`CommandCode network failure.${hint}`);
    case 7:
      return new Error(`CommandCode API server error.${hint}`);
    case 8:
      return new Error(`CommandCode hit its turn limit.${hint}`);
    case 10:
      return new Error(`CommandCode has insufficient credits.${hint}`);
    case 130:
      return new Error("CommandCode turn was interrupted.");
    default:
      return new Error(
        `CommandCode exited${code == null ? "" : ` with code ${code}`}.${hint}`,
      );
  }
}

export function isCmdTransientNetworkError(
  errorMessage: string,
  code?: number | null,
): boolean {
  if (code === 6) return true;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes("network failure") ||
    msg.includes("can't assign requested address") ||
    msg.includes("cant assign requested address") ||
    msg.includes("eaddrnotavail") ||
    msg.includes("connection reset") ||
    msg.includes("econnreset") ||
    msg.includes("broken pipe") ||
    msg.includes("epipe") ||
    msg.includes("network is unreachable") ||
    msg.includes("enetunreach") ||
    msg.includes("no route to host") ||
    msg.includes("ehostunreach") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("tls handshake timeout") ||
    msg.includes("i/o timeout") ||
    msg.includes("client.timeout exceeded") ||
    msg.includes("context deadline exceeded") ||
    msg.includes("unexpected eof")
  );
}

export function formatCmdErrorMessage(rawError: string): string {
  const trimmed = rawError.trim();
  if (isCmdTransientNetworkError(trimmed)) {
    return `CommandCode network error: ${trimmed}`;
  }
  return trimmed;
}

function prettyCmdModelName(nativeId: string): string {
  const base = nativeId.split("/").pop() ?? nativeId;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "muse" ? "Muse" : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

/**
 * Reasoning-effort levels the `cmd` CLI accepts per model, probed with
 * `cmd -p --effort bogus-…` (`Unknown effort … Supported: …`). Effort is a
 * per-model setting because levels differ: Muse 1.3 contributor tops out at
 * xhigh, DeepSeek flash/pro only take high/max, MiniMax M3 has no xhigh at
 * all. Unknown ids fall back to the full range minus max.
 */
const CMD_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const CMD_EFFORT_OPTIONS: Record<string, string[]> = {
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "minimaxai/minimax-m3": ["low", "medium", "high"],
  "moonshotai/kimi-k3": ["low", "high", "max"],
  "meta/muse-spark-1.1": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
};

const CMD_DEFAULT_EFFORT: Record<string, string> = {
  "meta/muse-spark-1.3-contributor": "xhigh",
};

function cmdEffortSetting(nativeId: string): ModelSetting {
  const short = nativeId.includes("/") ? nativeId : `meta/${nativeId}`;
  const bare = short.split("/").pop() ?? short;
  const levels =
    CMD_EFFORT_OPTIONS[short] ??
    CMD_EFFORT_OPTIONS[bare] ??
    Object.keys(CMD_EFFORT_LABELS).filter((level) => level !== "max");
  const options = levels.map((value) => ({
    value,
    label: CMD_EFFORT_LABELS[value] ?? value,
  }));
  const fallback = levels.includes("high") ? "high" : (levels[0] ?? "high");
  const value =
    CMD_DEFAULT_EFFORT[short] ?? CMD_DEFAULT_EFFORT[bare] ?? fallback;
  return {
    id: "effort",
    label: "Reasoning",
    kind: "select",
    value: options.some((option) => option.value === value) ? value : fallback,
    options,
  };
}

/**
 * Parse `cmd --list-models` text output. Lines look like:
 *   deepseek/deepseek-v4-flash   fast hybrid-attention reasoning (default)
 * Section headers and the "Available models · N models" banner are skipped.
 */
export function modelsFromCmdListOutput(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^available models/i.test(line)) continue;
    const first = line.split(/\s+/)[0] ?? "";
    if (!first.includes("/")) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-+:]+$/.test(first)) continue;
    if (seen.has(first)) continue;
    seen.add(first);
    models.push({
      id: `cmd:${first}`,
      harness: "cmd",
      name: prettyCmdModelName(first),
      nativeId: first,
      settings: [cmdEffortSetting(first)],
    });
  }
  return models;
}

/** Native id flagged `(default)` in `cmd --list-models`, if any. */
export function defaultModelFromCmdListOutput(stdout: string): string | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const first = line.split(/\s+/)[0] ?? "";
    if (first.includes("/") && /\(default\)/i.test(line)) return first;
  }
  return null;
}
