// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimits } from "../lib/rateLimits";
import { projectKey } from "../lib/paths";
import { saveTabGroupMascot } from "../lib/tabGroups";
import { needsProviderLogin, UsageProviderChip } from "./UsageProviderChip";

const now = Date.parse("2026-09-16T12:00:00Z");

function codexLimits(): ProviderRateLimits {
  return {
    provider: "codex",
    session: {
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: now + 2 * 3_600_000,
    },
    weekly: {
      usedPercent: 81,
      windowMinutes: 10_080,
      resetsAt: now + 2 * 86_400_000 + 23 * 3_600_000,
    },
    resetCredits: {
      availableCount: 2,
      credits: [
        {
          id: "reset-1",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: now - 86_400_000,
          expiresAt: now + 12 * 86_400_000,
          title: "Referral reward",
          description: "One Codex rate-limit reset",
        },
        {
          id: "reset-2",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: now - 43_200_000,
          expiresAt: now + 18 * 86_400_000,
          title: "Backup reset",
          description: "A second Codex rate-limit reset",
        },
      ],
    },
    updatedAt: now,
    error: null,
    status: "ok",
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
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

describe("UsageProviderChip", () => {
  it("offers the provider-owned login flow for an expired Claude session", async () => {
    const limits: ProviderRateLimits = {
      provider: "claude",
      session: null,
      weekly: null,
      resetCredits: null,
      updatedAt: now,
      error: "Claude sign-in expired",
      status: "error",
    };
    const onReconnect = vi.fn(async () => undefined);
    act(() =>
      root.render(
        createElement(UsageProviderChip, { limits, now, onReconnect }),
      ),
    );

    await act(async () => button("Claude Code usage details").click());
    expect(document.querySelector(".size-9")).not.toBeNull();
    await act(async () => button("Sign in to Claude Code").click());

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Signed in to Claude Code");
  });

  it("does not describe account-specific usage restrictions as login failures", () => {
    const limits: ProviderRateLimits = {
      provider: "claude",
      session: null,
      weekly: null,
      resetCredits: null,
      updatedAt: now,
      error: "Claude usage is unavailable for this account",
      status: "error",
    };
    expect(needsProviderLogin(limits)).toBe(false);
  });

  it("opens a column of detailed progress bars", async () => {
    act(() =>
      root.render(
        createElement(UsageProviderChip, { limits: codexLimits(), now }),
      ),
    );

    const trigger = button("Codex usage details");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog?.textContent).toContain("5-hour limit");
    expect(dialog?.textContent).toContain("Weekly limit");
    expect(dialog?.textContent).toContain("58% remaining");
    expect(dialog?.textContent).toContain("19% remaining");
    expect(dialog?.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(
      dialog
        ?.querySelector('[aria-label="Weekly limit used"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("81");
  });

  it("shows and deliberately consumes a banked reset", async () => {
    const onConsumeReset = vi.fn(async () => "reset" as const);
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: codexLimits(),
          now,
          onConsumeReset,
        }),
      ),
    );

    await act(async () => button("Codex usage details").click());
    expect(document.body.textContent).toContain("2 resets available");
    expect(
      document.querySelector('[data-reset-mascot-mood="happy"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Referral reward");
    expect(document.body.textContent).toContain("Backup reset");
    expect(document.body.textContent).toContain("Expires in 12d");

    const list = document.querySelector(
      '[aria-label="Available banked resets"]',
    );
    expect(list?.classList.contains("overflow-y-auto")).toBe(true);
    const useButtons = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((item) => item.textContent === "Use reset");
    expect(useButtons).toHaveLength(2);
    act(() => useButtons[1]?.click());
    expect(document.body.textContent).toContain("Spend this reset now?");
    await act(async () => button("Confirm").click());

    expect(onConsumeReset).toHaveBeenCalledWith("reset-2");
    expect(document.body.textContent).toContain("Codex usage was reset.");
  });

  it("uses the project's picked mascot and gives an empty bank a sad pose", async () => {
    const project = "/repo/mascot-lab";
    saveTabGroupMascot(projectKey(project), "cat");
    const limits = codexLimits();
    limits.resetCredits = { availableCount: 0, credits: [] };
    act(() =>
      root.render(createElement(UsageProviderChip, { limits, now, project })),
    );

    await act(async () => button("Codex usage details").click());
    const mascot = document.querySelector('[data-reset-mascot-mood="sad"]');
    expect(mascot?.getAttribute("data-mascot-name")).toBe("cat");
    expect(document.body.textContent).toContain("No resets available");
  });

  it("keeps aggregate-only resets visible as claimable rows", async () => {
    const limits = codexLimits();
    limits.resetCredits = {
      availableCount: 2,
      credits: limits.resetCredits?.credits?.slice(0, 1) ?? null,
    };
    const onConsumeReset = vi.fn(async () => "reset" as const);
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits,
          now,
          onConsumeReset,
        }),
      ),
    );

    await act(async () => button("Codex usage details").click());
    expect(document.body.textContent).toContain("Referral reward");
    expect(document.body.textContent).toContain("Banked reset 2");
    const useButtons = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((item) => item.textContent === "Use reset");
    expect(useButtons).toHaveLength(2);
  });
});

describe("UsageProviderChip for Command Code", () => {
  function cmdLimits(): ProviderRateLimits {
    return {
      provider: "cmd",
      session: {
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: null,
      },
      weekly: {
        usedPercent: 40.4,
        windowMinutes: 10_080,
        resetsAt: now + 2 * 86_400_000,
      },
      resetCredits: null,
      cmdCredits: {
        monthlyCredits: 7.5776918458,
        purchasedCredits: 0,
        freeCredits: 0,
      },
      updatedAt: now,
      error: null,
      status: "ok",
    };
  }

  function cmdAccounts() {
    return {
      available: true,
      accountsDir: "/home/test/.local/bin/accounts",
      accounts: [
        { id: "1", userName: "onlygabriel1999gbum", keyName: "key-one" },
        { id: "2", userName: "gpiedadpersvk0y", keyName: "key-two" },
      ],
      activeId: "2",
      currentUser: "gpiedadpersvk0y",
      currentKey: "key-two",
      hint: null,
    };
  }

  function usageBody(fiveUsed: number, weeklyUsed: number): string {
    return JSON.stringify({
      credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        fiveHour: { used: fiveUsed, cap: 3, resetAt: 0 },
        weekly: { used: weeklyUsed, cap: 6, resetAt: 0 },
      },
    });
  }

  it("shows usage windows, credit balances, and the account list", async () => {
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: cmdAccounts(),
          onSwitchCmdAccount: vi.fn(async () => ({
            activeId: "2",
            userName: "gpiedadpersvk0y",
          })),
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("5-hour limit");
    expect(dialog?.textContent).toContain("Weekly limit");
    expect(dialog?.textContent).toContain("Monthly credits");
    expect(dialog?.textContent).toContain("Command Code account");
    expect(dialog?.textContent).toContain("onlygabriel1999gbum");
    expect(dialog?.textContent).toContain("gpiedadpersvk0y");
    expect(dialog?.textContent).toContain("Active");
    expect(dialog?.textContent).toContain("Switch");
  });

  it("shows per-account usage limits for swap decisions", async () => {
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: cmdAccounts(),
          cmdAccountsUsage: [
            {
              id: "1",
              userName: "onlygabriel1999gbum",
              keyName: "key-one",
              status: "ok",
              body: usageBody(0, 2.42),
              error: null,
            },
            {
              id: "2",
              userName: "gpiedadpersvk0y",
              keyName: "key-two",
              status: "error",
              body: null,
              error: "Command Code sign-in expired",
            },
          ],
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("5h 0% · wk 40%");
    expect(dialog?.textContent).toContain("Command Code sign-in expired");
  });

  it("marks per-account usage as pending before snapshots load", async () => {
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: cmdAccounts(),
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    expect(document.body.textContent).toContain("checking usage…");
  });

  it("refreshes account usage when the popover opens", async () => {
    const onRefreshCmdAccountsUsage = vi.fn();
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: cmdAccounts(),
          onRefreshCmdAccountsUsage,
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    expect(onRefreshCmdAccountsUsage).toHaveBeenCalledOnce();
  });

  it("switches to the chosen account", async () => {
    const onSwitchCmdAccount = vi.fn(async () => ({
      activeId: "1",
      userName: "onlygabriel1999gbum",
    }));
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: cmdAccounts(),
          onSwitchCmdAccount,
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    const switchButton = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent === "Switch");
    expect(switchButton).toBeDefined();
    await act(async () => switchButton!.click());
    expect(onSwitchCmdAccount).toHaveBeenCalledOnce();
    expect(onSwitchCmdAccount).toHaveBeenCalledWith("1");
  });

  it("surfaces account switch failures", async () => {
    const onSwitchCmdAccount = vi.fn(async () => {
      throw new Error("Account not found");
    });
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: cmdAccounts(),
          onSwitchCmdAccount,
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    const switchButton = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent === "Switch");
    await act(async () => switchButton!.click());
    expect(document.body.textContent).toContain("Account not found");
  });

  it("explains when account switching is unavailable", async () => {
    act(() =>
      root.render(
        createElement(UsageProviderChip, {
          limits: cmdLimits(),
          now,
          cmdAccounts: {
            available: false,
            accountsDir: null,
            accounts: [],
            activeId: null,
            currentUser: null,
            currentKey: null,
            hint: "cc-switch was not found.",
          },
        }),
      ),
    );

    await act(async () => button("CommandCode usage details").click());
    expect(document.body.textContent).toContain("cc-switch was not found.");
    expect(document.body.textContent).not.toContain("Switch");
  });
});
