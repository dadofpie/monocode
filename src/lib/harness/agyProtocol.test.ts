import { describe, expect, it } from "vitest";
import type { Attachment } from "../session";
import {
  agyPromptWithAttachments,
  buildAgySpawnArgs,
  formatAgyErrorMessage,
  isAgyTransientNetworkError,
  modelsFromAgyListOutput,
  parseAgyLine,
  resultStatusFromAgy,
  sessionIdFromAgyLine,
  toolRefFromAgyStep,
} from "./agyProtocol";

describe("agy protocol", () => {
  it("resumes with --conversation and stream-json print mode", () => {    expect(
      buildAgySpawnArgs({
        text: "hi",
        resume: "conv-1",
        runtimeMode: "full-access",
        model: "gemini-3.8-flash-high",
      }),
    ).toEqual([
      "-p",
      "hi",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "--conversation",
      "conv-1",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3.8-flash-high",
    ]);
  });

  it("sends pasted images as exact-read path references, never base64", () => {
    // agy --input-format stream-json rejects image content blocks (verified
    // against the CLI: only "text" is accepted), so like cmd the prompt must
    // stay a short path reference and keep base64 out of argv.
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
    const prompt = agyPromptWithAttachments({ text: "look", attachments });
    expect(prompt).toContain('"/tmp/monocode-attachments/red.png"');
    expect(prompt).toContain("Read this exact file only");
    expect(prompt).not.toContain("base64");
    expect(prompt).not.toContain(data);
    const args = buildAgySpawnArgs({
      text: "look",
      attachments,
      runtimeMode: "supervised",
    });
    expect(args.join("\n")).not.toContain(data);
  });

  it("parses init, tools, and result frames", () => {
    const init = parseAgyLine(
      '{"event":"init","conversation_id":"c1"}',
    );
    expect(sessionIdFromAgyLine(init!)).toBe("c1");
    const tool = parseAgyLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "c1",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { parameters: { Path: "/tmp/a.md" } },
        },
      }),
    );
    expect(toolRefFromAgyStep(tool!.step_update as Record<string, unknown>)).toEqual({
      callId: "2:view_file",
      name: "view_file",
      input: { Path: "/tmp/a.md" },
    });
    const result = parseAgyLine(
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"pong"}}',
    );
    expect(resultStatusFromAgy(result!)).toEqual({
      status: "completed",
      text: "pong",
    });
  });

  it("keeps effort suffixes so flash variants are distinct", () => {
    const models = modelsFromAgyListOutput(
      [
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
        "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
        "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      ].join("\n"),
    );
    expect(models.map((model) => model.name)).toEqual([
      "Gemini 3.8 Flash (High)",
      "Gemini 3.8 Flash (Medium)",
      "Gemini 3.8 Flash (Low)",
    ]);
  });

  it("parses agy models list output", () => {
    const models = modelsFromAgyListOutput(
      "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
    );
    expect(models.map((model) => model.name)).toEqual([
      "Gemini 3.8 Flash (High)",
      "Claude Sonnet 4.6 (Thinking)",
    ]);
    expect(models[0]).toMatchObject({
      id: "agy:gemini-3.8-flash-high",
      harness: "agy",
      nativeId: "gemini-3.8-flash-high",
    });
  });

  it("identifies transient network and socket assignment errors", () => {
    const socketErr =
      'agent executor error: generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 192.168.68.115:58864->172.217.117.4:443: read: can\'t assign requested address';
    expect(isAgyTransientNetworkError(socketErr)).toBe(true);
    expect(isAgyTransientNetworkError("read tcp 1.2.3.4:1234: connection reset by peer")).toBe(true);
    expect(isAgyTransientNetworkError("TLS handshake timeout")).toBe(true);
    expect(isAgyTransientNetworkError("network is unreachable")).toBe(true);
    expect(isAgyTransientNetworkError("broken pipe")).toBe(true);

    // Permanent errors must not be flagged as transient
    expect(isAgyTransientNetworkError("Invalid model: gemini-custom")).toBe(false);
    expect(isAgyTransientNetworkError("Permission denied for file /etc/hosts")).toBe(false);
  });

  it("formats agy error messages with helpful hints for socket errors", () => {
    const socketErr =
      'read: can\'t assign requested address';
    expect(formatAgyErrorMessage(socketErr)).toContain(
      "local network socket unavailable",
    );
    expect(formatAgyErrorMessage("connection reset")).toContain(
      "Antigravity network error: connection reset",
    );
    expect(formatAgyErrorMessage("Non-network failure")).toBe("Non-network failure");
  });
});
