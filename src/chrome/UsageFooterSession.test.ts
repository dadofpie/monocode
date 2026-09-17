// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageFooter } from "./UsageFooter";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
    expect(trigger.textContent).toContain("50% · 170K");
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

  it("omits the chip until the harness reports usage", () => {
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
