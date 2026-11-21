import {
  WS_METHODS,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
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
  const automation = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issue-trackers:automation",
    tag: WS_METHODS.issueTrackersAutomation,
  });
  const automationCatalog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issue-trackers:automation-catalog",
    tag: WS_METHODS.issueTrackersAutomationCatalog,
  });
  const refresh = (environmentId: Parameters<typeof connections>[0]["environmentId"]) =>
    connections({ environmentId, input: {} });
  // Connect, disconnect and bind all edit one environment's tracker state; serialized so a
  // disconnect cannot race the bind of a project to the tracker being removed.
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    connections,
    /** Issue status rules, and how each one's last status read went. */
    automation,
    /** A tracker's teams or boards, and with `containerId` that one's workflow statuses. */
    automationCatalog,
    /** Saves a rule the tracker can reach, or removes one with a null rule. */
    saveAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issue-trackers:save-automation",
      tag: WS_METHODS.issueTrackersSaveAutomation,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(automation({ environmentId: target.environmentId, input: {} })),
        ),
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

/**
 * The line under a tracker's name. A connected tracker lists nothing until a project is linked
 * to one of its scopes, so the line says how many are, and what to do when none is.
 */
export function issueTrackerSummary(
  tracker: IssueTrackerConnection,
  bindings: IssueTrackerConnectionList["bindings"],
): string {
  if (!tracker.connected) {
    // Mid-sentence case, keeping an acronym: "personal API key", "API token".
    const credential = tracker.credential.label
      .split(" ")
      .map((word) => (word === word.toUpperCase() ? word : word.toLowerCase()))
      .join(" ");
    return `Not connected. Add your ${credential} to list its issues.`;
  }
  if (tracker.account === null) return tracker.detail ?? "The saved credential was rejected.";
  const linked = Object.values(bindings).filter(
    (binding) => binding.tracker === tracker.tracker,
  ).length;
  const projects =
    linked === 0
      ? `no projects linked yet. Pick a ${tracker.scopeNoun} for a project to list its issues.`
      : `${linked} ${linked === 1 ? "project" : "projects"} linked`;
  return `Connected as ${tracker.account} · ${projects}`;
}
