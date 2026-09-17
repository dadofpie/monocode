import { RefreshCw, Terminal } from "./icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { HarnessIcon } from "./HarnessIcon";
import { Popover, type PopoverDismissReason } from "./Popover";
import {
  consumeCodexRateLimitResetCredit,
  fetchAgyRateLimits,
  fetchClaudeRateLimits,
  fetchCmdAccounts,
  fetchCmdAccountsUsage,
  fetchCmdRateLimits,
  fetchCodexRateLimits,
  fetchOpencodeUsageSummary,
  switchCmdAccount as requestCmdAccountSwitch,
  type CmdAccountState,
  type CmdAccountSwitch,
  type CmdAccountUsageSnapshot,
  type OpencodeUsageSummary,
  type OpencodeUsageTotals,
} from "../lib/rateLimitsFetch";
import {
  errorRateLimits,
  fetchingRateLimits,
  idleRateLimits,
  RATE_LIMIT_POLL_MS,
  shouldFetchProvider,
  type ProviderRateLimits,
  type RateLimitProvider,
} from "../lib/rateLimits";
import { HARNESS_LABEL, HARNESS_TITLE, type HarnessId } from "../lib/session";
import type { TurnMetrics } from "../lib/session";
import {
  contextPercent,
  formatTokens,
  type ContextUsage,
} from "../lib/contextUsage";
import { loginHarness, supportsHarnessLogin } from "../lib/harness/auth";
import {
  runningTerminalChipLabel,
  type RunningTerminal,
} from "../lib/terminalTab";
import { MOD } from "../lib/platform";
import { UsageProviderChip } from "./UsageProviderChip";
import {
  ProviderSignInPanel,
  type ProviderSignInState,
} from "./ProviderSignInPanel";

const CLOCK_MS = 30_000;

export type UsageFooterSession = {
  id?: string;
  harness: HarnessId;
  authRequired?: boolean;
  /** Latest reported session token totals, for harnesses without provider billing. */
  turnMetrics?: TurnMetrics;
  /** Latest reported context-window level. */
  context?: ContextUsage;
};

export function UsageFooter({
  providers,
  session,
  project,
  terminals = [],
  terminalOpen = false,
  onToggleTerminal,
  onNewTerminal,
  onShowTerminal,
  projectTerminalActive = false,
}: {
  providers: RateLimitProvider[];
  session?: UsageFooterSession;
  project?: string;
  terminals?: RunningTerminal[];
  terminalOpen?: boolean;
  onToggleTerminal?: (fileId: string) => void;
  onNewTerminal?: () => void;
  onShowTerminal?: () => void;
  projectTerminalActive?: boolean;
}) {
  const wantClaude = providers.includes("claude");
  const wantCodex = providers.includes("codex");
  const wantCmd = providers.includes("cmd");
  const wantAgy = providers.includes("agy");
  const [claude, setClaude] = useState<ProviderRateLimits>(() =>
    idleRateLimits("claude"),
  );
  const [codex, setCodex] = useState<ProviderRateLimits>(() =>
    idleRateLimits("codex"),
  );
  const [cmd, setCmd] = useState<ProviderRateLimits>(() =>
    idleRateLimits("cmd"),
  );
  const [agy, setAgy] = useState<ProviderRateLimits>(() =>
    idleRateLimits("agy"),
  );
  const [cmdAccounts, setCmdAccounts] = useState<CmdAccountState | null>(null);
  const [cmdAccountsUsage, setCmdAccountsUsage] = useState<
    CmdAccountUsageSnapshot[] | null
  >(null);
  const cmdAccountsUsageAt = useRef(0);
  const [opencodeSummary, setOpencodeSummary] =
    useState<OpencodeUsageSummary | null>(null);
  const opencodeSummaryAt = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);
  const claudeRef = useRef(claude);
  const codexRef = useRef(codex);
  const cmdRef = useRef(cmd);
  const agyRef = useRef(agy);
  claudeRef.current = claude;
  codexRef.current = codex;
  cmdRef.current = cmd;
  agyRef.current = agy;

  const refreshCmdAccountsUsage = useCallback(async (force = false) => {
    if (!wantCmd) return;
    const nowMs = Date.now();
    if (!force && nowMs - cmdAccountsUsageAt.current < 60_000) return;
    try {
      setCmdAccountsUsage(await fetchCmdAccountsUsage());
      cmdAccountsUsageAt.current = Date.now();
    } catch {
      // Rows fall back to "usage unavailable"; the account list still works.
    }
  }, [wantCmd]);

  const refresh = useCallback(
    (force = false) => {
      if (inflight.current) return inflight.current;
      const visible = document.visibilityState === "visible";
      const fetchClaude =
        wantClaude &&
        shouldFetchProvider(claudeRef.current, { force, visible });
      const fetchCodex =
        wantCodex && shouldFetchProvider(codexRef.current, { force, visible });
      const fetchCmd =
        wantCmd && shouldFetchProvider(cmdRef.current, { force, visible });
      const fetchAgy =
        wantAgy && shouldFetchProvider(agyRef.current, { force, visible });
      if (!fetchClaude && !fetchCodex && !fetchCmd && !fetchAgy) return;
      if (force) setRefreshing(true);
      if (force && wantCmd) void refreshCmdAccountsUsage(true);
      const jobs: Promise<void>[] = [];
      if (fetchClaude) {
        setClaude((current) => fetchingRateLimits("claude", current));
        jobs.push(
          fetchClaudeRateLimits().then((value) => {
            setClaude(value);
          }),
        );
      }
      if (fetchCodex) {
        setCodex((current) => fetchingRateLimits("codex", current));
        jobs.push(
          fetchCodexRateLimits().then((value) => {
            setCodex(value);
          }),
        );
      }
      if (fetchCmd) {
        setCmd((current) => fetchingRateLimits("cmd", current));
        jobs.push(
          fetchCmdRateLimits().then((value) => {
            setCmd(value);
          }),
        );
      }
      if (fetchAgy) {
        setAgy((current) => fetchingRateLimits("agy", current));
        jobs.push(
          fetchAgyRateLimits().then((value) => {
            setAgy(value);
          }),
        );
      }
      const run = Promise.allSettled(jobs)
        .then(() => undefined)
        .finally(() => {
          inflight.current = null;
          setRefreshing(false);
        });
      inflight.current = run;
      return run;
    },
    [wantClaude, wantCodex, wantCmd, wantAgy, refreshCmdAccountsUsage],
  );

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), RATE_LIMIT_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const consumeCodexReset = useCallback(async (creditId?: string) => {
    while (inflight.current) await inflight.current;
    setRefreshing(true);
    setCodex((current) => fetchingRateLimits("codex", current));
    let outcome: Awaited<ReturnType<typeof consumeCodexRateLimitResetCredit>>;
    const operation = (async () => {
      try {
        outcome = await consumeCodexRateLimitResetCredit(creditId);
        setCodex(await fetchCodexRateLimits());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not use Codex reset";
        setCodex((current) => errorRateLimits("codex", message, current));
        throw error;
      }
    })();
    const tracked = operation.finally(() => {
      inflight.current = null;
      setRefreshing(false);
    });
    inflight.current = tracked.catch(() => undefined);
    await tracked;
    return outcome!;
  }, []);

  const reconnectProvider = useCallback(
    async (
      provider: RateLimitProvider,
      fetchLimits: () => Promise<ProviderRateLimits>,
      setLimits: Dispatch<SetStateAction<ProviderRateLimits>>,
    ) => {
      while (inflight.current) await inflight.current;
      setRefreshing(true);
      setLimits((current) => fetchingRateLimits(provider, current));
      const operation = (async () => {
        try {
          await loginHarness(provider);
          const value = await fetchLimits();
          setLimits(value);
          if (value.status !== "ok") {
            throw new Error(
              value.error ||
                `${HARNESS_TITLE[provider]} sign-in could not be verified`,
            );
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not complete sign-in";
          setLimits((current) => errorRateLimits(provider, message, current));
          throw error;
        }
      })();
      const tracked = operation.finally(() => {
        inflight.current = null;
        setRefreshing(false);
      });
      inflight.current = tracked.catch(() => undefined);
      await tracked;
    },
    [],
  );

  const refreshCmdAccounts = useCallback(async () => {
    if (!wantCmd) return;
    try {
      setCmdAccounts(await fetchCmdAccounts());
    } catch {
      // Keep the last known account list; switching stays available.
    }
  }, [wantCmd]);

  const refreshOpencodeSummary = useCallback(
    async (force = false) => {
      if (session?.harness !== "opencode") return;
      const nowMs = Date.now();
      if (!force && nowMs - opencodeSummaryAt.current < 60_000) return;
      try {
        setOpencodeSummary(await fetchOpencodeUsageSummary());
        opencodeSummaryAt.current = Date.now();
      } catch {
        // The section falls back to its loading state.
      }
    },
    [session?.harness],
  );

  useEffect(() => {
    void refreshCmdAccounts();
    void refreshCmdAccountsUsage();
    void refreshOpencodeSummary();
  }, [refreshCmdAccounts, refreshCmdAccountsUsage, refreshOpencodeSummary]);

  const switchCmdAccount = useCallback(
    async (id: string): Promise<CmdAccountSwitch> => {
      while (inflight.current) await inflight.current;
      setRefreshing(true);
      let result: CmdAccountSwitch;
      const operation = (async () => {
        result = await requestCmdAccountSwitch(id);
        setCmdAccounts(await fetchCmdAccounts());
        // Usage is keyed to the active account file, so re-read it too.
        setCmd(await fetchCmdRateLimits());
        await refreshCmdAccountsUsage(true);
      })();
      const tracked = operation.finally(() => {
        inflight.current = null;
        setRefreshing(false);
      });
      inflight.current = tracked.catch(() => undefined);
      await tracked;
      return result!;
    },
    [refreshCmdAccountsUsage],
  );

  const reconnectClaude = useCallback(
    () => reconnectProvider("claude", fetchClaudeRateLimits, setClaude),
    [reconnectProvider],
  );

  const reconnectCodex = useCallback(
    () => reconnectProvider("codex", fetchCodexRateLimits, setCodex),
    [reconnectProvider],
  );

  const showUsage = wantClaude || wantCodex || wantCmd || wantAgy;
  const showTerminals = terminals.length > 0;
  const showTerminalButton = Boolean(onNewTerminal || onShowTerminal);
  const terminalLabel = projectTerminalActive
    ? "Terminal"
    : `New Terminal (${MOD}\`)`;
  const onTerminalClick = projectTerminalActive
    ? (onShowTerminal ?? onNewTerminal)
    : (onNewTerminal ?? onShowTerminal);
  const ariaLabel = showUsage
    ? "Provider usage"
    : showTerminals || showTerminalButton
      ? "Terminals"
      : session
        ? "Session"
        : undefined;

  return (
    <footer
      aria-label={ariaLabel}
      className="flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-stroke px-3 text-[11px] text-content/55"
    >
      {showUsage ? (
        <>
          {wantClaude ? (
            <UsageProviderChip
              limits={claude}
              now={now}
              onReconnect={reconnectClaude}
            />
          ) : null}
          {wantCodex ? (
            <UsageProviderChip
              limits={codex}
              now={now}
              project={project}
              onConsumeReset={consumeCodexReset}
              onReconnect={reconnectCodex}
            />
          ) : null}
          {wantCmd ? (
            <UsageProviderChip
              limits={cmd}
              now={now}
              cmdAccounts={cmdAccounts}
              cmdAccountsUsage={cmdAccountsUsage}
              onSwitchCmdAccount={switchCmdAccount}
              onRefreshCmdAccountsUsage={() =>
                void refreshCmdAccountsUsage()
              }
            />
          ) : null}
          {wantAgy ? (
            <UsageProviderChip limits={agy} now={now} />
          ) : null}
          <button
            type="button"
            className="grid size-4.5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-50"
            aria-label="Refresh usage"
            title="Refresh usage"
            disabled={refreshing}
            onClick={() => void refresh(true)}
          >
            <RefreshCw
              className={`size-2.5 ${refreshing ? "animate-spin" : ""}`}
              strokeWidth={1.75}
              aria-hidden
            />
          </button>
        </>
      ) : session ? (
        session.harness === "opencode" ? (
          <SessionUsageChip
            key={session.id ?? session.harness}
            session={session}
            summary={opencodeSummary}
            onRefreshSummary={() => void refreshOpencodeSummary()}
          />
        ) : (
          <SessionChip key={session.id ?? session.harness} session={session} />
        )
      ) : null}
      {showTerminals || showTerminalButton ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {showTerminals ? (
            <RunningTerminalChip
              terminals={terminals}
              open={terminalOpen}
              onToggle={onToggleTerminal}
            />
          ) : showTerminalButton ? (
            <button
              type="button"
              className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
                projectTerminalActive
                  ? "text-accent"
                  : "text-content/40 hover:text-content"
              }`}
              aria-label={terminalLabel}
              aria-pressed={projectTerminalActive}
              title={terminalLabel}
              onClick={onTerminalClick}
            >
              <Terminal className="size-3.5" strokeWidth={1.75} aria-hidden />
              <span>Terminal</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}

function TerminalLiveMark() {
  return (
    <span className="terminal-live shrink-0" aria-hidden>
      <span className="terminal-live-bar" />
      <span className="terminal-live-bar" />
      <span className="terminal-live-bar" />
    </span>
  );
}

function SessionChip({ session }: { session: UsageFooterSession }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [loginState, setLoginState] = useState<ProviderSignInState>("idle");
  const [loginError, setLoginError] = useState<string | null>(null);
  const authRequired = Boolean(
    session.authRequired && loginState !== "complete",
  );
  const canLogin = authRequired && supportsHarnessLogin(session.harness);

  useEffect(() => {
    if (!session.authRequired && loginState === "complete") {
      setLoginState("idle");
    }
  }, [loginState, session.authRequired]);

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape") {
      requestAnimationFrame(() => trigger.current?.focus());
    }
  };

  const signIn = async () => {
    setLoginState("running");
    setLoginError(null);
    try {
      await loginHarness(session.harness);
      setOpen(false);
      setLoginState("complete");
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : "Could not complete sign-in",
      );
      setLoginState("error");
    }
  };

  if (!canLogin) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
        title={HARNESS_TITLE[session.harness]}
      >
        <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
        <span>{HARNESS_LABEL[session.harness]}</span>
      </span>
    );
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="-mx-1 inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 text-content/55 transition-[background-color,color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
        aria-label={`${HARNESS_TITLE[session.harness]} sign-in required`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${HARNESS_TITLE[session.harness]} sign-in required`}
        onClick={() => setOpen((value) => !value)}
      >
        <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
        <span>{HARNESS_LABEL[session.harness]}</span>
        {authRequired ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-300">
            sign in
          </span>
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="top"
          align="start"
          gap={7}
          width={300}
          autoFocus
          onDismiss={dismiss}
          role="dialog"
          aria-label={`${HARNESS_TITLE[session.harness]} sign-in`}
          tabIndex={-1}
          className="text-content"
        >
          <ProviderSignInPanel
            harness={session.harness}
            state={loginState}
            error={loginError}
            onSignIn={() => void signIn()}
          />
        </Popover>
      ) : null}
    </>
  );
}

function sessionTokenTotal(metrics: TurnMetrics): number {
  return (
    (metrics.inputTokens ?? 0) +
    (metrics.outputTokens ?? 0) +
    (metrics.cacheReadTokens ?? 0) +
    (metrics.cacheWriteTokens ?? 0)
  );
}

function opencodeTotalsText(totals: OpencodeUsageTotals): string {
  const tokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const cost = totals.cost > 0.005 ? ` · $${totals.cost.toFixed(2)}` : "";
  return `${formatTokens(tokens)}${cost}`;
}

/**
 * Clickable session usage chip for harnesses without provider billing
 * (OpenCode reports tokens per message, but OpenCode Go exposes no usage
 * endpoint). Session totals come from the harness-reported aggregates already
 * stored on the session; the over-time section is aggregated from the local
 * OpenCode database and refreshed whenever the popover opens.
 */
function SessionUsageChip({
  session,
  summary,
  onRefreshSummary,
}: {
  session: UsageFooterSession;
  summary?: OpencodeUsageSummary | null;
  onRefreshSummary?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const metrics = session.turnMetrics;
  const context = session.context;
  const percent = contextPercent(context);
  const total = metrics ? sessionTokenTotal(metrics) : 0;
  const hasTokens = metrics != null && total > 0;
  // Without reported usage this is just the static session label, exactly
  // what SessionChip renders for harnesses with no sign-in flow.
  if (!hasTokens && percent == null) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
        title={HARNESS_TITLE[session.harness]}
      >
        <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
        <span>{HARNESS_LABEL[session.harness]}</span>
      </span>
    );
  }

  const usageLabel =
    percent != null && hasTokens
      ? `${percent}% · ${formatTokens(total)}`
      : percent != null
        ? `${percent}%`
        : formatTokens(total);
  const label = `${HARNESS_LABEL[session.harness]} ${usageLabel}`;
  const description =
    percent != null && hasTokens
      ? `${percent}% context · ${formatTokens(total)} tokens this session`
      : percent != null
        ? `${percent}% context used`
        : `${formatTokens(total)} tokens this session`;

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape") {
      requestAnimationFrame(() => trigger.current?.focus());
    }
  };

  const toggle = () => {
    if (!open) onRefreshSummary?.();
    setOpen((value) => !value);
  };

  const rows: Array<{ label: string; value: string }> = [];
  if (metrics?.inputTokens) {
    rows.push({ label: "Input", value: formatTokens(metrics.inputTokens) });
  }
  if (metrics?.outputTokens) {
    rows.push({ label: "Output", value: formatTokens(metrics.outputTokens) });
  }
  if (metrics?.cacheReadTokens) {
    rows.push({
      label: "Cache read",
      value: formatTokens(metrics.cacheReadTokens),
    });
  }
  if (metrics?.cacheWriteTokens) {
    rows.push({
      label: "Cache write",
      value: formatTokens(metrics.cacheWriteTokens),
    });
  }
  if (metrics?.cacheHitPercent != null) {
    rows.push({
      label: "Cache hit",
      value: `${Math.round(metrics.cacheHitPercent)}%`,
    });
  }

  const barPct = percent ?? 0;
  const remaining = Math.max(0, 100 - barPct);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="-mx-1 inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 text-content/55 transition-[background-color,color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
        aria-label="Session usage details"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={description}
        onClick={toggle}
      >
        <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
        <span className="tabular-nums">{label}</span>
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="top"
          align="start"
          gap={7}
          width={300}
          maxHeight={460}
          autoFocus
          onDismiss={dismiss}
          role="dialog"
          aria-label="Session usage details"
          tabIndex={-1}
          className="overflow-y-auto p-2.5 text-content"
        >
          <div className="flex items-start gap-2.5 px-1 pb-2.5 pt-0.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-content/[0.06] ring-1 ring-inset ring-content/[0.07]">
              <HarnessIcon harness={session.harness} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-medium leading-4">
                Session usage
              </h2>
              <p className="mt-0.5 text-[10px] leading-4 text-content/40">
                {description}
              </p>
            </div>
          </div>

          {context ? (
            <section className="rounded-lg bg-content/[0.045] px-3 py-2.5 ring-1 ring-inset ring-content/[0.06]">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-[11px] font-medium text-content/65">
                  Context window
                </h3>
                <span className="shrink-0 text-[11px] font-medium tabular-nums">
                  {percent != null ? `${percent}% used` : "tracking"}
                </span>
              </div>
              {percent != null ? (
                <>
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-content/10"
                    role="progressbar"
                    aria-label="Context window used"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span
                      className={`block h-full rounded-full ${barPct >= 90 ? "bg-red-400" : barPct >= 80 ? "bg-amber-400" : "bg-content/45"}`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] leading-4 text-content/40">
                    <span className="tabular-nums">{remaining}% remaining</span>
                    <span className="truncate text-right tabular-nums">
                      {context.window
                        ? `${formatTokens(context.used)} / ${formatTokens(context.window)}`
                        : `${formatTokens(context.used)} tokens`}
                    </span>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          {rows.length > 0 ? (
            <section className="mt-1.5 rounded-lg bg-content/[0.045] px-3 py-2.5 ring-1 ring-inset ring-content/[0.06]">
              <h3 className="text-[11px] font-medium text-content/65">
                Tokens this session
              </h3>
              <dl className="mt-1.5 flex flex-col gap-1">
                {rows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-baseline justify-between gap-3 text-[10px] leading-4"
                  >
                    <dt className="text-content/40">{row.label}</dt>
                    <dd className="shrink-0 font-medium tabular-nums">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {summary ? (
            summary.available ? (
              <section className="mt-1.5 rounded-lg bg-content/[0.045] px-3 py-2.5 ring-1 ring-inset ring-content/[0.06]">
                <h3 className="text-[11px] font-medium text-content/65">
                  Usage over time
                </h3>
                <dl className="mt-1.5 flex flex-col gap-1">
                  {[
                    { label: "Last 24 hours", totals: summary.day },
                    { label: "Last 7 days", totals: summary.week },
                    { label: "Last 30 days", totals: summary.month },
                  ].map((entry) => (
                    <div
                      key={entry.label}
                      className="flex items-baseline justify-between gap-3 text-[10px] leading-4"
                    >
                      <dt className="text-content/40">{entry.label}</dt>
                      <dd className="shrink-0 font-medium tabular-nums">
                        {opencodeTotalsText(entry.totals)}
                      </dd>
                    </div>
                  ))}
                  {summary.topModels.slice(0, 3).map((model) => (
                    <div
                      key={model.model}
                      className="flex items-baseline justify-between gap-3 text-[10px] leading-4"
                    >
                      <dt
                        className="min-w-0 flex-1 truncate text-content/40"
                        title={`${model.provider}/${model.model}`}
                      >
                        {model.model}
                      </dt>
                      <dd className="shrink-0 font-medium tabular-nums">
                        {formatTokens(model.tokens)}
                        {model.cost > 0.005
                          ? ` · $${model.cost.toFixed(2)}`
                          : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-1.5 text-[10px] leading-4 text-content/40">
                  {summary.sessions30d} session
                  {summary.sessions30d === 1 ? "" : "s"} in 30 days
                </p>
              </section>
            ) : (
              <p className="mt-1.5 px-1 text-[10px] leading-4 text-content/40">
                Usage history unavailable.
              </p>
            )
          ) : (
            <p className="mt-1.5 px-1 text-[10px] leading-4 text-content/40">
              Loading usage history…
            </p>
          )}

          {!context && rows.length === 0 ? (
            <div className="rounded-lg bg-content/[0.04] px-3 py-4 text-center ring-1 ring-inset ring-content/[0.06]">
              <p className="text-[11px] font-medium text-content/65">
                No usage reported yet
              </p>
              <p className="mx-auto mt-1 max-w-[15rem] text-[10px] leading-4 text-content/40">
                Token counts appear here once the agent answers.
              </p>
            </div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

function RunningTerminalChip({
  terminals,
  open: panelOpen,
  onToggle,
}: {
  terminals: RunningTerminal[];
  open: boolean;
  onToggle?: (fileId: string) => void;
}) {
  const root = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const label = runningTerminalChipLabel(terminals);
  const many = terminals.length > 1;
  const title = terminals
    .map((terminal) => `"${terminal.process}" in ${terminal.label}`)
    .join("\n");
  const ariaLabel =
    terminals.length === 1
      ? panelOpen
        ? `Hide ${terminals[0]?.process}`
        : `Show ${terminals[0]?.process}`
      : panelOpen
        ? "Hide running terminals"
        : `${terminals.length} terminals are running processes`;

  const toggle = (fileId: string) => {
    setMenuOpen(false);
    onToggle?.(fileId);
  };

  return (
    <>
      <button
        ref={root}
        type="button"
        className="inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 whitespace-nowrap rounded px-1 -mx-1 hover:bg-content/10 hover:text-content"
        aria-label={ariaLabel}
        aria-pressed={panelOpen}
        aria-expanded={many && !panelOpen ? menuOpen : undefined}
        aria-haspopup={many && !panelOpen ? "menu" : undefined}
        title={title}
        onClick={() => {
          if (panelOpen || !many) {
            const target = terminals[0];
            if (target) toggle(target.id);
            return;
          }
          setMenuOpen((value) => !value);
        }}
      >
        <TerminalLiveMark />
        <span className="truncate font-mono text-[10px] tabular-nums">
          {label}
        </span>
      </button>
      {menuOpen && many && !panelOpen ? (
        <Popover
          anchor={root}
          side="top"
          align="end"
          autoFocus
          onDismiss={() => setMenuOpen(false)}
          role="menu"
          aria-label="Running terminals"
          className="min-w-[12rem] p-1"
        >
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              role="menuitem"
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(terminal.id)}
            >
              <span className="min-w-0 flex-1 truncate">
                {terminal.process}
              </span>
              <span className="max-w-[7rem] shrink-0 truncate text-[11px] text-content/40">
                {terminal.label}
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}
