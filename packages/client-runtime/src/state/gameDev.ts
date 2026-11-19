import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamCommand,
} from "./runtime.ts";

/** Game Development: editors, the bridge, checkpoints, and assets on the chosen environment. */
export function createGameDevEnvironmentAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const command = <const Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(name: string, tag: Tag) =>
    createEnvironmentRpcCommand(runtime, { label: `environment-data:game-dev:${name}`, tag });
  return {
    overview: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:game-dev:overview", tag: WS_METHODS.gameDevGetOverview, staleTimeMs: 5_000 }),
    workspace: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:game-dev:workspace", tag: WS_METHODS.gameDevWorkspace, staleTimeMs: 1_500 }),
    assets: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:game-dev:assets", tag: WS_METHODS.gameDevAssets, staleTimeMs: 3_000 }),
    install: createEnvironmentRpcStreamCommand(runtime, {
      label: "environment-data:game-dev:install",
      tag: WS_METHODS.gameDevInstall,
      concurrency: { mode: "singleFlight", key: ({ environmentId, input }) => `${environmentId}:${input.input.target}` },
    }),
    detectProjects: command("detect-projects", WS_METHODS.gameDevDetectProjects),
    locate: command("locate", WS_METHODS.gameDevLocate),
    openProject: command("open-project", WS_METHODS.gameDevOpenProject),
    bindSession: command("bind-session", WS_METHODS.gameDevBindSession),
    updateSettings: command("update-settings", WS_METHODS.gameDevUpdateSettings),
    command: command("command", WS_METHODS.gameDevCommand),
    getCapture: command("get-capture", WS_METHODS.gameDevGetCapture),
    resolveApproval: command("resolve-approval", WS_METHODS.gameDevResolveApproval),
    checkpointCreate: command("checkpoint-create", WS_METHODS.gameDevCheckpointCreate),
    checkpointDiff: command("checkpoint-diff", WS_METHODS.gameDevCheckpointDiff),
    checkpointRestore: command("checkpoint-restore", WS_METHODS.gameDevCheckpointRestore),
    assetPreview: command("asset-preview", WS_METHODS.gameDevAssetPreview),
    assetImport: command("asset-import", WS_METHODS.gameDevAssetImport),
    setForgeGuiKey: command("set-forgegui-key", WS_METHODS.gameDevSetForgeGuiKey),
    testForgeGui: command("test-forgegui", WS_METHODS.gameDevTestForgeGui),
  };
}
