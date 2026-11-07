import {
  type MentionIndexProviderId,
  type MentionIndexSearchInput,
  WS_METHODS,
  type ProjectId,
} from "@t3tools/contracts";
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
    thumbnail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mentions:thumbnail",
      tag: WS_METHODS.mentionsThumbnail,
    }),
    figmaListTeams: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mentions:figma-list-teams",
      tag: WS_METHODS.mentionsFigmaListTeams,
    }),
    figmaListProjects: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mentions:figma-list-projects",
      tag: WS_METHODS.mentionsFigmaListProjects,
    }),
  };
}

export type MentionIndexAtoms = ReturnType<typeof createMentionIndexAtoms>;

export function mentionSearchInput(input: {
  readonly projectId: ProjectId;
  readonly query: string;
  readonly limit?: number;
  readonly providers?: ReadonlyArray<MentionIndexProviderId>;
}): MentionIndexSearchInput {
  return {
    projectId: input.projectId,
    providers: input.providers ?? ["pull-request"],
    query: input.query,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}
