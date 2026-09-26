import { ADAPTER_ID, uninstallHooks } from "./hooks";
import { uninstallPermissions } from "./permissions";
import { uninstallUpdater } from "./updater";
import { removeAllPathRules, pruneIfCreated } from "./pathRules";
import { removeInstructionBlock } from "../shared/instructionBlock";
import { deleteManifest, loadManifest } from "../../core/installs";

/** Removes everything the Claude Code adapter installed, except the read logger (see `cube log uninstall`). */
export async function uninstallAll(root: string): Promise<void> {
  for (const scope of ["local", "shared"] as const) {
    const m = loadManifest(root, ADAPTER_ID, scope);
    if (!m) continue;
    const cubeFeatures = m.features.filter((f) => f !== "log");
    if (cubeFeatures.length) uninstallHooks(root, { features: cubeFeatures as any, scope });
  }
  uninstallPermissions(root);
  uninstallUpdater(root);
  removeAllPathRules(root);
  removeInstructionBlock(root, ADAPTER_ID);
  pruneIfCreated(root);
  const shared = loadManifest(root, ADAPTER_ID, "shared");
  if (shared && !shared.features.length && !shared.files.length && !shared.block && !shared.settings?.permissions?.rules.length) {
    deleteManifest(root, ADAPTER_ID, "shared");
  }
}
