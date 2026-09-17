import { describe, expect, it } from "vitest";
import { latestUserTurnMetrics } from "./session";

describe("latestUserTurnMetrics", () => {
  it("returns undefined when no user block carries metrics", () => {
    expect(latestUserTurnMetrics([])).toBeUndefined();
    expect(
      latestUserTurnMetrics([
        { id: "a", role: "user", text: "hi" },
        { id: "b", role: "assistant", text: "hello" },
      ]),
    ).toBeUndefined();
  });

  it("takes the running aggregate from the latest user block", () => {
    // Harnesses overwrite the aggregate onto the latest user turn, so the
    // last one wins instead of summing across turns.
    const blocks = [
      {
        id: "a",
        role: "user",
        text: "first",
        turnMetrics: { inputTokens: 100, outputTokens: 50 },
      },
      { id: "b", role: "assistant", text: "answer" },
      {
        id: "c",
        role: "user",
        text: "second",
        turnMetrics: { inputTokens: 300, outputTokens: 120 },
      },
    ] as const;
    expect(latestUserTurnMetrics(blocks)).toEqual({
      inputTokens: 300,
      outputTokens: 120,
    });
  });

  it("falls back to an earlier turn while the latest has no report yet", () => {
    const blocks = [
      {
        id: "a",
        role: "user",
        text: "first",
        turnMetrics: { inputTokens: 100, outputTokens: 50 },
      },
      { id: "b", role: "user", text: "just sent" },
    ] as const;
    expect(latestUserTurnMetrics(blocks)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});
