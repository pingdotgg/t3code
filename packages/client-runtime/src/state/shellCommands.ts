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
    // A command rather than a query atom: the list is only needed while the
    // "Open with" dialog is open, and fetching on open keeps a freshly
    // installed application from being masked by a cached subscription.
    listInstalledApplications: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:list-installed-applications",
      tag: WS_METHODS.shellListInstalledApplications,
    }),
  };
}
