import {
  WS_METHODS,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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

// Tracker packages name their credential and scope in English, so a sentence is translated only
// when it matches a known tracker's whole sentence; any other tracker keeps the English one.
function knownTrackerSentence(
  english: string,
  candidates: ReadonlyArray<string>,
  resolve: MFunctionType,
): string {
  const known = candidates.find((candidate) => mFallback(candidate) === english);
  return known === undefined ? english : resolve(known);
}

const SERVER_TRACKER_DETAILS = [msg("Issues cannot be browsed for this host yet.")];

/** A tracker's `detail` from the issue list, translated when it is a fixed server line. */
export function issueTrackerDetailText(detail: string, resolve: MFunctionType = mFallback): string {
  return knownTrackerSentence(detail, SERVER_TRACKER_DETAILS, resolve);
}

/**
 * The line under a tracker's name. A connected tracker lists nothing until a project is linked
 * to one of its scopes, so the line says how many are, and what to do when none is.
 */
export function issueTrackerSummary(
  tracker: IssueTrackerConnection,
  bindings: IssueTrackerConnectionList["bindings"],
  resolve: MFunctionType = mFallback,
): string {
  if (!tracker.connected)
    return knownTrackerSentence(
      `Not connected. Add a ${tracker.credential.label.toLowerCase()} to list its issues.`,
      [msg("Not connected. Add a personal api key to list its issues.")],
      resolve,
    );
  if (tracker.account === null)
    return tracker.detail ?? resolve(msg("The saved credential was rejected."));
  const linked = Object.values(bindings).filter(
    (binding) => binding.tracker === tracker.tracker,
  ).length;
  return linked === 0
    ? knownTrackerSentence(
        `Connected as ${tracker.account} · no projects linked yet. Pick a ${tracker.scopeNoun} for a project to list its issues.`,
        [
          msg(
            "Connected as {account} · no projects linked yet. Pick a team for a project to list its issues.",
            { account: tracker.account },
          ),
        ],
        resolve,
      )
    : resolve(
        msg(
          "{count, plural, one {Connected as {account} · {count} project linked} other {Connected as {account} · {count} projects linked}}",
          { account: tracker.account, count: linked },
        ),
      );
}
