import { describe, expect, it } from "vitest";
import { attachmentPathText } from "../attachments";
import type { Attachment } from "../session";
import {
  buildCmdSpawnArgs,
  cmdEventType,
  cmdExitError,
  cmdFrameType,
  cmdModeArgs,
  cmdPromptWithAttachments,
  cmdToolTitle,
  defaultModelFromCmdListOutput,
  modelsFromCmdListOutput,
  parseCmdLine,
  resultStatusFromCmd,
  sessionIdFromCmdLine,
  toolKindFromCmdName,
  toolRefFromCmdEvent,
} from "./cmdProtocol";

const TOOL_QUEUED =
  '{"type":"event","event":{"type":"tool_queued","toolCallId":"call_1","toolName":"read_file","input":{"file_path":"/repo/README.md"}}}';
const TOOL_RUNNING =
  '{"type":"event","event":{"type":"tool_running","toolCallId":"call_1","toolName":"read_file","description":null}}';
const RESULT_SUCCESS =
  '{"type":"result","subtype":"success","sessionId":"abc","stopReason":"end_turn","usage":{},"durationMs":100,"finalText":"ok"}';

describe("cmd protocol", () => {
  it("maps runtime modes to permission flags", () => {
    expect(cmdModeArgs("supervised")).toEqual([]);
    expect(cmdModeArgs("auto-accept-edits")).toEqual(["--auto-accept"]);
    expect(cmdModeArgs("auto")).toEqual(["--auto-accept"]);
    expect(cmdModeArgs("full-access")).toEqual(["--yolo"]);
  });

  it("builds one-shot print-mode spawn args", () => {
    expect(
      buildCmdSpawnArgs({ text: "hi", runtimeMode: "full-access" }),
    ).toEqual([
      "-p",
      "hi",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--trust",
      "--yolo",
    ]);
  });

  it("resumes follow-ups by provider session id", () => {
    const args = buildCmdSpawnArgs({
      text: "again",
      resume: "sess-1",
      model: "deepseek/deepseek-v4-flash",
      effort: "high",
      maxTurns: 10,
      runtimeMode: "supervised",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("sess-1");
    expect(args).toContain("--model");
    expect(args).toContain("--effort");
    expect(args).toContain("--max-turns");
  });

  it("parses frames and skips non-JSON progress text", () => {
    expect(parseCmdLine("  not json  ")).toBeNull();
    const rec = parseCmdLine(TOOL_QUEUED);
    expect(rec).not.toBeNull();
    if (!rec) return;
    expect(cmdFrameType(rec)).toBe("event");
    expect(cmdEventType(rec)).toBe("tool_queued");
  });

  it("reads tool refs from queued/running events", () => {
    const queued = parseCmdLine(TOOL_QUEUED);
    const running = parseCmdLine(TOOL_RUNNING);
    if (!queued || !running) throw new Error("fixtures must parse");
    expect(toolRefFromCmdEvent(queued.event as Record<string, unknown>)).toEqual({
      callId: "call_1",
      name: "read_file",
      input: { file_path: "/repo/README.md" },
    });
    expect(toolRefFromCmdEvent(running.event as Record<string, unknown>)).toEqual({
      callId: "call_1",
      name: "read_file",
      input: {},
    });
  });

  it("binds provider sessions from run_start and result lines", () => {
    const start = parseCmdLine(
      '{"type":"event","event":{"type":"run_start","sessionId":"s-1"}}',
    );
    const result = parseCmdLine(RESULT_SUCCESS);
    if (!start || !result) throw new Error("fixtures must parse");
    expect(sessionIdFromCmdLine(start)).toBe("s-1");
    expect(sessionIdFromCmdLine(result)).toBe("abc");
  });

  it("maps result subtypes to turn outcomes", () => {
    const ok = parseCmdLine(RESULT_SUCCESS);
    if (!ok) throw new Error("fixture must parse");
    expect(resultStatusFromCmd(ok)).toEqual({ status: "completed" });
    expect(
      resultStatusFromCmd({ type: "result", subtype: "max_turns" }),
    ).toEqual({ status: "completed", maxTurns: true });
    expect(
      resultStatusFromCmd({ type: "result", subtype: "error", error: "boom" }),
    ).toEqual({ status: "failed", error: "boom" });
  });

  it("maps exit codes to actionable errors", () => {
    expect(cmdExitError(3, "").message).toMatch(/not authenticated/);
    expect(cmdExitError(10, "").message).toMatch(/credits/);
    expect(cmdExitError(130, "").message).toMatch(/interrupted/);
    expect(cmdExitError(1, "  some failure  ").message).toMatch(/some failure/);
  });

  it("classifies cmd tool names", () => {
    expect(toolKindFromCmdName("read_file")).toBe("read");
    expect(toolKindFromCmdName("write_file")).toBe("edit");
    expect(toolKindFromCmdName("shell_command")).toBe("shell");
    expect(toolKindFromCmdName("grep")).toBe("search");
    expect(toolKindFromCmdName("agent")).toBe("agent");
    expect(toolKindFromCmdName("todo_write")).toBe("task");
    expect(toolKindFromCmdName("ask_user_question")).toBe("question");
  });

  it("titles tools from their inputs", () => {
    expect(
      cmdToolTitle("read_file", { file_path: "/repo/README.md" }),
    ).toMatch(/README/);
    expect(cmdToolTitle("grep", { pattern: "hello" })).toMatch(/hello/);
  });

  it("parses cmd --list-models output", () => {
    const output = [
      "Available models  ·  3 models",
      "",
      "Open Source",
      "",
      "deepseek/deepseek-v4-flash               fast hybrid-attention reasoning (default)",
      "moonshotai/kimi-k3                       long-horizon coding",
      "meta/muse-spark-1.3-contributor        Muse Spark 1.3 at up to 95% off",
      "not-a-model-line",
    ].join("\n");
    const models = modelsFromCmdListOutput(output);
    expect(models.map((model) => model.nativeId)).toEqual([
      "deepseek/deepseek-v4-flash",
      "moonshotai/kimi-k3",
      "meta/muse-spark-1.3-contributor",
    ]);
    expect(models[0]).toMatchObject({ id: "cmd:deepseek/deepseek-v4-flash", harness: "cmd" });
    expect(defaultModelFromCmdListOutput(output)).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("attaches per-model effort levels with xhigh default for muse 1.3 contributor", () => {
    const output = [
      "meta/muse-spark-1.3-contributor        Muse Spark 1.3 at up to 95% off",
      "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning",
      "minimaxai/minimax-m3                   frontier coding",
      "some-org/unknown-model                 something new",
    ].join("\n");
    const models = modelsFromCmdListOutput(output);
    const effort = (nativeId: string) =>
      models
        .find((model) => model.nativeId === nativeId)
        ?.settings?.find((setting) => setting.id === "effort");
    expect(effort("meta/muse-spark-1.3-contributor")).toMatchObject({
      value: "xhigh",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
    });
    expect(
      effort("deepseek/deepseek-v4-flash")?.options.map((option) => option.value),
    ).toEqual(["high", "max"]);
    expect(
      effort("minimaxai/minimax-m3")?.options.map((option) => option.value),
    ).toEqual(["low", "medium", "high"]);
    expect(
      effort("some-org/unknown-model")?.options.map((option) => option.value),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("appends attachments as path lines in the print-mode prompt", () => {
    const attachments: Attachment[] = [
      {
        id: "a",
        name: "report.pdf",
        mimeType: "application/pdf",
        kind: "file",
        size: 100,
        path: "/tmp/report.pdf",
      },
    ];
    expect(cmdPromptWithAttachments({ text: "hi", attachments })).toBe(
      `hi\n\n${attachmentPathText(attachments[0] as Attachment)}`,
    );
    expect(cmdPromptWithAttachments({ text: "hi" })).toBe("hi");
    const args = buildCmdSpawnArgs({
      text: "hi",
      attachments,
      runtimeMode: "supervised",
    });
    expect(args[1]).toContain("Attached file");
  });

  it("sends pasted images as exact-read path references, never base64", () => {
    // cmd -p has no vision channel (verified against the CLI: markdown and
    // @-mention forms also resolve through a read_file tool call), so the
    // prompt must stay a short path reference and keep base64 out of argv.
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const attachments: Attachment[] = [
      {
        id: "img",
        name: "red.png",
        mimeType: "image/png",
        kind: "image",
        size: 95,
        path: "/tmp/monocode-attachments/red.png",
        data,
      },
    ];
    const prompt = cmdPromptWithAttachments({ text: "look", attachments });
    expect(prompt).toContain('"/tmp/monocode-attachments/red.png"');
    expect(prompt).toContain("Read this exact file only");
    expect(prompt).not.toContain("base64");
    expect(prompt).not.toContain(data);
    const args = buildCmdSpawnArgs({
      text: "look",
      attachments,
      runtimeMode: "supervised",
    });
    expect(args.join("\n")).not.toContain(data);
  });
});
