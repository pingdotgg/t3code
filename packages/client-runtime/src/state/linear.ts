import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    authStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:auth-status",
      tag: WS_METHODS.linearAuthStatus,
    }),
    searchIssues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:search-issues",
      tag: WS_METHODS.linearSearchIssues,
    }),
    fetchIssues: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:fetch-issues",
      tag: WS_METHODS.linearFetchIssues,
      scheduler: commandScheduler,
    }),
    setToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:set-token",
      tag: WS_METHODS.linearSetToken,
      scheduler: commandScheduler,
    }),
    clearToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:clear-token",
      tag: WS_METHODS.linearClearToken,
      scheduler: commandScheduler,
    }),
  };
}
