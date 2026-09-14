import {
  killChild,
  resolveAgyBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import { buildAgySpawnArgs, parseAgyLine, resultStatusFromAgy } from "./agyProtocol";

const TEXT_CHILD_ID = "monocode-agy-text";
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * One-shot text generation through `cmd -p --no-session`. Unlike Claude's
 * persistent text child, Antigravity's print mode exits on its own, so each
 * call spawns, collects the result line's finalText, and reaps the child.
 */
export async function runAgyTextPrompt(input: {
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<string> {
  const { path } = await resolveAgyBinary();
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let output = "";
  let settled = false;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Antigravity text generation timed out"));
      void killChild(TEXT_CHILD_ID).catch(() => undefined);
    }, timeoutMs);

    watchChild(
      TEXT_CHILD_ID,
      (line) => {
        if (settled) return;
        const rec = parseAgyLine(line);
        if (!rec || rec.event !== "result") return;
        settled = true;
        clearTimeout(timer);
        const outcome = resultStatusFromAgy(rec);
        if (outcome.status === "failed") {
          reject(new Error(outcome.error || "Antigravity turn failed"));
          return;
        }
        output = outcome.text ?? "";
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (output.trim()) resolve();
        else reject(new Error("Antigravity text generator exited"));
      },
    );
  });

  try {
    await spawnChild(
      TEXT_CHILD_ID,
      path,
      buildAgySpawnArgs({
        text: input.prompt,
        model: input.model,
        runtimeMode: "full-access",
      }),
      input.cwd,
    );
    await done;
  } finally {
    unwatchChild(TEXT_CHILD_ID);
    await killChild(TEXT_CHILD_ID).catch(() => undefined);
  }

  const trimmed = output.trim();
  if (!trimmed) throw new Error("Antigravity returned empty output.");
  return trimmed;
}

export function warmupAgyText(_cwd: string): Promise<void> {
  // Nothing to warm: every text call is a fresh one-shot child.
  return Promise.resolve();
}
