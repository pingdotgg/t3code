import type { EnvironmentId, LinearMutationInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const counter = () => Atom.family((_id: EnvironmentId) => Atom.make(0).pipe(Atom.keepAlive));
  const refreshes = counter();
  const signals = {
    workspace: counter(),
    team: counter(),
    issues: counter(),
    projects: counter(),
    documents: counter(),
    inbox: counter(),
  };
  type Domain = keyof typeof signals;
  const trigger =
    (domain: Domain) =>
    ({ environmentId }: { environmentId: EnvironmentId }) =>
      Atom.make((get) => get(refreshes(environmentId)) + get(signals[domain](environmentId)));
  const refresh = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(refreshes(target.environmentId), (n) => n + 1));
  const invalidate = (
    target: { readonly environmentId: EnvironmentId; readonly input: LinearMutationInput },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      const kind = target.input.kind;
      const domains: ReadonlyArray<Domain> = kind.startsWith("notification")
        ? ["inbox"]
        : kind.startsWith("document")
          ? ["documents", "projects"]
          : kind.startsWith("project")
            ? ["projects", "team"]
            : kind.startsWith("cycle")
              ? ["team", "issues"]
              : ["issues"];
      for (const domain of domains)
        registry.update(signals[domain](target.environmentId), (n) => n + 1);
    });
  return {
    refreshes,
    upload: createEnvironmentRpcCommand(runtime, {
      label: "linear:upload",
      tag: WS_METHODS.linearUpload,
    }),
    connection: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:connection",
      tag: WS_METHODS.linearConnection,
      staleTimeMs: 30_000,
      refreshTrigger: trigger("workspace"),
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "linear:configure",
      tag: WS_METHODS.linearConfigure,
      onSettled: refresh,
    }),
    workspace: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:workspace",
      tag: WS_METHODS.linearWorkspace,
      staleTimeMs: 30_000,
      refreshTrigger: trigger("workspace"),
    }),
    teamContext: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:teamContext",
      tag: WS_METHODS.linearTeamContext,
      staleTimeMs: 30_000,
      refreshTrigger: trigger("team"),
    }),
    issues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:issues",
      tag: WS_METHODS.linearIssues,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: trigger("issues"),
    }),
    issue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:issue",
      tag: WS_METHODS.linearIssue,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: trigger("issues"),
    }),
    comments: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:comments",
      tag: WS_METHODS.linearComments,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: trigger("issues"),
    }),
    projects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:projects",
      tag: WS_METHODS.linearProjects,
      staleTimeMs: 30_000,
      refreshTrigger: trigger("projects"),
    }),
    project: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:project",
      tag: WS_METHODS.linearProject,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: trigger("projects"),
    }),
    documents: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:documents",
      tag: WS_METHODS.linearDocuments,
      staleTimeMs: 30_000,
      refreshTrigger: trigger("documents"),
    }),
    document: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:document",
      tag: WS_METHODS.linearDocument,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: trigger("documents"),
    }),
    inbox: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "linear:inbox",
      tag: WS_METHODS.linearInbox,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: trigger("inbox"),
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "linear:mutate",
      tag: WS_METHODS.linearMutate,
      onSettled: invalidate,
    }),
  };
}
