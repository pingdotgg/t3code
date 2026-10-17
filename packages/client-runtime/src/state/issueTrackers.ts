import { WS_METHODS, type IssueTrackerScopesInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "./runtime.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";

/**
 * Standalone issue trackers (Linear, Jira) per environment: which are connected, as whom, which
 * scopes they reach, and which project is bound to which scope. One query carries all of it, and
 * every mutation refreshes that query, so the settings page never shows a stale status.
 */
export function createIssueTrackerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const connections = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issue-trackers:connections",
    tag: WS_METHODS.issueTrackersList,
  });
  const refresh = (environmentId: Parameters<typeof connections>[0]["environmentId"]) =>
    connections({ environmentId, input: {} });
  // Connect, disconnect and bind all edit one environment's tracker state; serialized so a
  // disconnect cannot race the bind of a project to the tracker being removed.
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const readScopes = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:issue-trackers:read-scopes",
    tag: WS_METHODS.issueTrackersScopes,
  });
  return {
    connections,
    scopes: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:issue-trackers:scopes",
      execute: (input: IssueTrackerScopesInput) =>
        Effect.gen(function* () {
          const registry = yield* AtomRegistry.AtomRegistry;
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const result = yield* Effect.promise(() =>
            readScopes.run(registry, { environmentId: supervisor.target.environmentId, input }),
          );
          if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
          return result.value;
        }),
    }),
    /** Saves a credential the tracker accepted, or removes the stored one with a null token. */
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issue-trackers:connect",
      tag: WS_METHODS.issueTrackersConnect,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: (target, registry) =>
        Effect.sync(() => registry.refresh(refresh(target.environmentId))),
    }),
    bindProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issue-trackers:bind-project",
      tag: WS_METHODS.issueTrackersBindProject,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: (target, registry) =>
        Effect.sync(() => registry.refresh(refresh(target.environmentId))),
    }),
  };
}
