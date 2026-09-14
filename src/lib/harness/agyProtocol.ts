import type { AgentModel } from "../models";
import type { Attachment, RuntimeMode, ToolPreview } from "../session";
import { attachmentPathText } from "../attachments";
import { extractToolPreview, titleFromToolInput } from "./preview";

/**
 * Antigravity CLI (`agy`) print-mode stream-json.
 *
 *   {"event":"init","conversation_id":"…",…}
 *   {"event":"step_update","step_update":{step_type,state,text_delta,tool_name,…}}
 *   {"event":"result","result":{status:"SUCCESS"|"ERROR",response,conversation_id}}
 */

export type AgySpawnInput = {
  text: string;
  model?: string;
  effort?: string;
  resume?: string;
  runtimeMode: RuntimeMode;
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

export function parseAgyLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function agyEventName(rec: Record<string, unknown>): string {
  return strField(rec, "event");
}

export function agyStepUpdate(
  rec: Record<string, unknown>,
): Record<string, unknown> | null {
  return agyEventName(rec) === "step_update"
    ? asRecord(rec.step_update)
    : null;
}

export function agyResult(
  rec: Record<string, unknown>,
): Record<string, unknown> | null {
  return agyEventName(rec) === "result" ? asRecord(rec.result) : null;
}

export function agyModeArgs(runtimeMode: RuntimeMode): string[] {
  switch (runtimeMode) {
    case "full-access":
      return ["--dangerously-skip-permissions"];
    case "auto-accept-edits":
    case "auto":
    case "supervised":
    default:
      return ["--mode", "accept-edits"];
  }
}

export function buildAgySpawnArgs(input: AgySpawnInput): string[] {
  const args = [
    "-p",
    agyPromptWithAttachments(input),
    "--output-format",
    "stream-json",
    "--print-timeout",
    "30m",
  ];
  if (input.resume) args.push("--conversation", input.resume);
  args.push(...agyModeArgs(input.runtimeMode));
  const model = input.model?.trim();
  if (model) args.push("--model", model);
  const effort = input.effort?.trim();
  if (effort) args.push("--effort", effort);
  return args;
}

export function agyPromptWithAttachments(input: {
  text: string;
  attachments?: Attachment[];
}): string {
  const paths = (input.attachments ?? []).map((attachment) =>
    attachmentPathText(attachment),
  );
  return [input.text, ...paths].filter((part) => part.trim()).join("\n\n");
}

export function sessionIdFromAgyLine(
  rec: Record<string, unknown>,
): string | undefined {
  const top = strField(rec, "conversation_id");
  if (top) return top;
  const step = asRecord(rec.step_update);
  const fromStep = step ? strField(step, "conversation_id") : "";
  if (fromStep) return fromStep;
  const result = asRecord(rec.result);
  const fromResult = result ? strField(result, "conversation_id") : "";
  return fromResult || undefined;
}

export type AgyToolRef = {
  callId: string;
  name: string;
  input: Record<string, unknown>;
};

export function toolRefFromAgyStep(
  step: Record<string, unknown>,
): AgyToolRef | null {
  const name = strField(step, "tool_name");
  if (!name) return null;
  const index = step.step_index;
  const callId = `${typeof index === "number" ? index : strField(step, "step_index")}:${name}`;
  const info = asRecord(step.tool_info);
  const parameters = info ? asRecord(info.parameters) : null;
  return { callId, name, input: parameters ?? {} };
}

export function toolKindFromAgyName(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes("write") || name.includes("replace") || name === "sed_file") {
    return "edit";
  }
  if (name.includes("view") || name.includes("read") || name === "list_dir") {
    return "read";
  }
  if (name.includes("grep") || name.includes("search") || name === "find_by_name") {
    return "search";
  }
  if (name.includes("command") || name.includes("shell")) return "shell";
  if (name.includes("browser")) return "browser";
  if (name.includes("subagent") || name === "define_subagent") return "agent";
  if (name.includes("task")) return "task";
  if (name.includes("ask") || name.includes("question")) return "question";
  return "tool";
}

export function agyToolTitle(
  name: string,
  input: Record<string, unknown>,
): string {
  return titleFromToolInput(name, toolKindFromAgyName(name), input);
}

export function agyPreviewFromTool(
  name: string,
  input: Record<string, unknown>,
): ToolPreview | undefined {
  const kind = toolKindFromAgyName(name);
  return extractToolPreview(
    { title: name, name, kind, rawInput: input, input },
    { title: name, name, kind, rawInput: input },
  );
}

export function summarizeAgyTool(
  name: string,
  input: Record<string, unknown>,
): string {
  for (const key of [
    "Path",
    "path",
    "FilePath",
    "SearchDirectory",
    "Pattern",
    "Command",
    "command",
    "Url",
    "url",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return name;
}

export type AgyResultStatus = {
  status: "completed" | "failed";
  error?: string;
  text?: string;
};

export function resultStatusFromAgy(rec: Record<string, unknown>): AgyResultStatus {
  const result = agyResult(rec);
  if (!result) return { status: "failed", error: "Antigravity returned no result." };
  const status = strField(result, "status").toUpperCase();
  const text = strField(result, "response");
  if (status === "SUCCESS" || status === "OK" || !status) {
    return { status: "completed", text };
  }
  return {
    status: "failed",
    error: strField(result, "error") || text || "Antigravity turn failed",
  };
}

export function agyExitError(code: number | null, stderrTail: string): Error {
  const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" ").trim();
  const hint = tail ? ` ${tail.slice(0, 240)}` : "";
  if (code === 130) return new Error("Antigravity turn was interrupted.");
  return new Error(
    `Antigravity exited${code == null ? "" : ` with code ${code}`}.${hint}`,
  );
}

export function isAgyTransientNetworkError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return (
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
    msg.includes("unexpected eof") ||
    msg.includes("streamgeneratecontent") ||
    msg.includes("read tcp") ||
    msg.includes("write tcp") ||
    msg.includes("dial tcp") ||
    msg.includes("temporary failure in name resolution") ||
    msg.includes("nodename nor servname provided") ||
    msg.includes("getaddrinfo")
  );
}

export function formatAgyErrorMessage(rawError: string): string {
  const trimmed = rawError.trim();
  if (isAgyTransientNetworkError(trimmed)) {
    if (
      trimmed.includes("can't assign requested address") ||
      trimmed.includes("eaddrnotavail")
    ) {
      return `Antigravity network error: local network socket unavailable (${trimmed}). Please check your connection and retry.`;
    }
    return `Antigravity network error: ${trimmed}`;
  }
  return trimmed;
}

export function modelsFromAgyListOutput(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching/i.test(line)) continue;
    const [idPart, ...rest] = line.split(/\t+/);
    const nativeId = (idPart ?? "").split(/\s{2,}/)[0]?.trim() ?? "";
    if (!nativeId || !/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(nativeId)) continue;
    if (nativeId.toLowerCase() === "id" || nativeId.toLowerCase() === "model") {
      continue;
    }
    if (seen.has(nativeId)) continue;
    seen.add(nativeId);
    const label = rest.join(" ").trim() || prettyAgyModelName(nativeId);
    models.push({
      id: `agy:${nativeId}`,
      harness: "agy",
      name: label,
      nativeId,
    });
  }
  return models;
}

export function defaultModelFromAgyListOutput(stdout: string): string | null {
  return modelsFromAgyListOutput(stdout)[0]?.nativeId ?? null;
}

function prettyAgyModelName(nativeId: string): string {
  return nativeId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
