import { homeDir } from "../fs";
import { setHarnessModels } from "../models";
import { execChild, resolveCmdBinary } from "./child";
import {
  defaultModelFromCmdListOutput,
  modelsFromCmdListOutput,
} from "./cmdProtocol";

let inflight: Promise<void> | null = null;

export function refreshCmdCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = discoverCmdModels()
    .then((models) => {
      if (models.length > 0) setHarnessModels("cmd", models);
    })
    .catch((error: unknown) => {
      console.debug("[monocode] cmd catalog", error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function discoverCmdModels() {
  const { path } = await resolveCmdBinary();
  const cwd = await homeDir();
  const output = await execChild(path, ["--list-models"], cwd);
  const models = modelsFromCmdListOutput(output);
  // Prefer the CLI-flagged default so a fresh catalog keeps working.
  const preferred = defaultModelFromCmdListOutput(output);
  if (preferred) {
    const idx = models.findIndex((model) => model.nativeId === preferred);
    if (idx > 0) {
      const [hit] = models.splice(idx, 1);
      if (hit) models.unshift(hit);
    }
  }
  return models;
}
