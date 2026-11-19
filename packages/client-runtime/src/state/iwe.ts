import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamCommand,
} from "./runtime.ts";

/** IWE notes workspaces on the chosen environment. */
export function createIweEnvironmentAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const command = <const Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(name: string, tag: Tag) =>
    createEnvironmentRpcCommand(runtime, { label: `environment-data:iwe:${name}`, tag });
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:iwe:status", tag: WS_METHODS.iweStatus, staleTimeMs: 30_000 }),
    workspace: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:iwe:workspace", tag: WS_METHODS.iweWorkspace, staleTimeMs: 15_000 }),
    searchResults: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:iwe:search-results", tag: WS_METHODS.iweSearch, staleTimeMs: 5_000 }),
    threadState: createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:iwe:thread-state", tag: WS_METHODS.iweThreadState, staleTimeMs: 3_000 }),
    install: createEnvironmentRpcStreamCommand(runtime, {
      label: "environment-data:iwe:install",
      tag: WS_METHODS.iweInstall,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    prepareWorkspace: command("prepare-workspace", WS_METHODS.iwePrepareWorkspace),
    search: command("search", WS_METHODS.iweSearch),
    note: command("note", WS_METHODS.iweNote),
    saveNote: command("save-note", WS_METHODS.iweSaveNote),
    createNote: command("create-note", WS_METHODS.iweCreateNote),
    renameNote: command("rename-note", WS_METHODS.iweRenameNote),
    complete: command("complete", WS_METHODS.iweComplete),
    renameLink: command("rename-link", WS_METHODS.iweRenameLink),
    attach: command("attach", WS_METHODS.iweAttach),
    detach: command("detach", WS_METHODS.iweDetach),
    selectWorkspace: command("select-workspace", WS_METHODS.iweSelectWorkspace),
  };
}
