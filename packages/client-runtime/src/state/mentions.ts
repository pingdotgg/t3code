import { type MentionIndexSearchInput, WS_METHODS, type ProjectId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createMentionIndexAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mentions:search",
      tag: WS_METHODS.mentionsSearch,
      staleTimeMs: 15_000,
    }),
    ensureIndexed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mentions:ensure-indexed",
      tag: WS_METHODS.mentionsEnsureIndexed,
    }),
  };
}

export type MentionIndexAtoms = ReturnType<typeof createMentionIndexAtoms>;

export function mentionSearchInput(input: {
  readonly projectId: ProjectId;
  readonly query: string;
  readonly limit?: number;
}): MentionIndexSearchInput {
  return {
    projectId: input.projectId,
    providers: ["pull-request"],
    query: input.query,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}
