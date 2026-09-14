import {
  bindAgySession,
  cancelAgyTurn,
  forgetAgySession,
  respondAgyApproval,
  sendAgyTurn,
  steerAgyTurn,
  stopAgySession,
} from "./agy";
import { refreshAgyCatalog } from "./agyCatalog";
import {
  generateAgyBranchName,
  generateAgyCommitMessage,
  generateAgyPrContent,
} from "./agyGit";
import { generateAgySessionTitle } from "./agyTitle";
import { warmupAgyText } from "./agyText";
import { registerHarness, type HarnessAdapter } from "./registry";

export const agyAdapter: HarnessAdapter = {
  id: "agy",
  live: true,
  canSteer: false,
  sendTurn: sendAgyTurn,
  steerTurn: steerAgyTurn,
  cancelTurn: cancelAgyTurn,
  respondApproval: respondAgyApproval,
  stopSession: stopAgySession,
  forgetSession: forgetAgySession,
  bindSession: bindAgySession,
  refreshCatalog: refreshAgyCatalog,
  generateTitle: generateAgySessionTitle,
  generateCommitMessage: generateAgyCommitMessage,
  generatePrContent: generateAgyPrContent,
  generateBranchName: generateAgyBranchName,
  warmupText: warmupAgyText,
};

let registered = false;

export function ensureAgyRegistered(): void {
  if (registered) return;
  registerHarness(agyAdapter);
  registered = true;
}
