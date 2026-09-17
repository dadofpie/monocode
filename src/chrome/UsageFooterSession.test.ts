// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageFooter } from "./UsageFooter";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockRejectedValue(new Error("No native bridge"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}

describe("UsageFooter session usage", () => {
  it("shows a clickable usage chip for opencode sessions", async () => {
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: {
            id: "session-1",
            harness: "opencode",
            turnMetrics: {
              inputTokens: 100_000,
              outputTokens: 50_000,
              cacheReadTokens: 20_000,
            },
            context: { used: 128_000, window: 256_000 },
          },
        }),
      ),
    );

    const trigger = button("Session usage details");
    expect(trigger.textContent).toContain("opencode 50% · 170K");
    // Session label and usage merge into a single chip.
    expect(
      document.querySelectorAll("footer button"),
    ).toHaveLength(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog?.textContent).toContain("Session usage");
    expect(dialog?.textContent).toContain("Context window");
    expect(dialog?.textContent).toContain("128K / 256K");
    expect(dialog?.textContent).toContain("Tokens this session");
    expect(dialog?.textContent).toContain("Input");
    expect(dialog?.textContent).toContain("Cache read");
  });

  it("shows cross-session usage over time", async () => {
    invoke.mockResolvedValue({
      available: true,
      day: {
        input: 1000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.02,
        messages: 3,
      },
      week: {
        input: 7000,
        output: 2000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.2,
        messages: 20,
      },
      month: {
        input: 100_000,
        output: 20_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 1.5,
        messages: 200,
      },
      sessions30d: 12,
      topModels: [
        {
          model: "muse-spark",
          provider: "opencode",
          tokens: 9000,
          cost: 0.1,
          messages: 5,
        },
      ],
      updatedAtMs: Date.now(),
    });
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: {
            id: "session-1",
            harness: "opencode",
            turnMetrics: { inputTokens: 100, outputTokens: 50 },
          },
        }),
      ),
    );

    await act(async () => button("Session usage details").click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(invoke).toHaveBeenCalledWith("fetch_opencode_usage_summary");
    expect(dialog?.textContent).toContain("Usage over time");
    expect(dialog?.textContent).toContain("Last 24 hours");
    expect(dialog?.textContent).toContain("1.5K · $0.02");
    expect(dialog?.textContent).toContain("12 sessions in 30 days");
    expect(dialog?.textContent).toContain("muse-spark");
  });

  it("waits for usage history while it loads", async () => {
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: {
            id: "session-1",
            harness: "opencode",
            turnMetrics: { inputTokens: 100, outputTokens: 50 },
          },
        }),
      ),
    );

    await act(async () => button("Session usage details").click());
    expect(document.body.textContent).toContain("Loading usage history…");
  });

  it("falls back to the static session label until usage is reported", () => {
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: { id: "session-1", harness: "opencode" },
        }),
      ),
    );

    expect(
      document.querySelector('button[aria-label="Session usage details"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain("opencode");
  });

  it("keeps provider-less harnesses other than opencode unchanged", () => {
    act(() =>
      root.render(
        createElement(UsageFooter, {
          providers: [],
          session: {
            id: "session-1",
            harness: "pi",
            turnMetrics: { inputTokens: 10, outputTokens: 5 },
          },
        }),
      ),
    );

    expect(
      document.querySelector('button[aria-label="Session usage details"]'),
    ).toBeNull();
  });
});
