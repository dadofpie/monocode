import { homeDir } from "../fs";
import { setHarnessModels } from "../models";
import { execChild, resolveAgyBinary } from "./child";
import {
  defaultModelFromAgyListOutput,
  modelsFromAgyListOutput,
} from "./agyProtocol";

let inflight: Promise<void> | null = null;

export function refreshAgyCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = discoverAgyModels()
    .then((models) => {
      if (models.length > 0) setHarnessModels("agy", models);
    })
    .catch((error: unknown) => {
      console.debug("[monocode] agy catalog", error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function discoverAgyModels() {
  const { path } = await resolveAgyBinary();
  const cwd = await homeDir();
  const output = await execChild(path, ["models"], cwd);
  const models = modelsFromAgyListOutput(output);
  // Prefer the CLI-flagged default so a fresh catalog keeps working.
  const preferred = defaultModelFromAgyListOutput(output);
  if (preferred) {
    const idx = models.findIndex((model) => model.nativeId === preferred);
    if (idx > 0) {
      const [hit] = models.splice(idx, 1);
      if (hit) models.unshift(hit);
    }
  }
  return models;
}
