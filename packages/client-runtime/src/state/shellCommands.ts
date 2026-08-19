import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createShellEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    openInEditor: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:open-in-editor",
      tag: WS_METHODS.shellOpenInEditor,
    }),
    // Commands, not query atoms: the list is only needed while the dialog is
    // open, and fetching on open shows a freshly installed application.
    listInstalledApplications: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:list-installed-applications",
      tag: WS_METHODS.shellListInstalledApplications,
    }),
    openInApplication: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:open-in-application",
      tag: WS_METHODS.shellOpenInApplication,
    }),
  };
}
