import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:status",
      tag: WS_METHODS.linearGetStatus,
    }),
    searchIssues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:search-issues",
      tag: WS_METHODS.linearSearchIssues,
    }),
    getIssue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:get-issue",
      tag: WS_METHODS.linearGetIssue,
    }),
  };
}
