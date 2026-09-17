import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  fetchCmdAccounts,
  fetchCmdAccountsUsage,
  switchCmdAccount,
} from "./rateLimitsFetch";

beforeEach(() => {
  invoke.mockReset();
});

describe("Command Code account bridge", () => {
  it("lists accounts through list_cmd_accounts", async () => {
    const state = { available: true, accounts: [] };
    invoke.mockResolvedValue(state);
    await expect(fetchCmdAccounts()).resolves.toBe(state);
    expect(invoke).toHaveBeenCalledWith("list_cmd_accounts");
  });

  it("switches through switch_cmd_account with the account id", async () => {
    const result = { activeId: "2", userName: "gpiedadpersvk0y" };
    invoke.mockResolvedValue(result);
    await expect(switchCmdAccount("2")).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith("switch_cmd_account", { id: "2" });
  });

  it("fetches per-account usage through fetch_cmd_accounts_usage", async () => {
    const snapshots = [
      { id: "1", status: "ok", body: "{}", error: null },
    ];
    invoke.mockResolvedValue(snapshots);
    await expect(fetchCmdAccountsUsage()).resolves.toBe(snapshots);
    expect(invoke).toHaveBeenCalledWith("fetch_cmd_accounts_usage");
  });
});
