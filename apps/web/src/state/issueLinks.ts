import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  ISSUE_LINKS_WS_METHODS,
  type IssueKey,
  issueKeyString,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { issueLinkChangesMatch } from "../components/issues/issueLinks.logic";
import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Stored Issue link changes on an environment, one batch per delivery: the atom keeps only the
 * latest value, so single changes arriving together would otherwise hide all but the last.
 */
const changes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issue-links:changes",
  tag: ISSUE_LINKS_WS_METHODS.subscribeChanges,
  transform: Stream.chunks,
});

/**
 * A refresh signal that moves only for batches naming its thread or Issues, so a link change refreshes the
 * thread and Issue rows it names rather than every mounted query on the environment.
 */
const changeSignal = Atom.family((key: string) => {
  const { environmentId, threadId, issues } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: string | null;
    readonly issues: ReadonlyArray<string>;
  };
  return Atom.make((get) => {
    const previous = Option.getOrElse(get.self<number>(), () => 0);
    const batch = AsyncResult.value(get(changes({ environmentId, input: {} })));
    return Option.isSome(batch) && issueLinkChangesMatch(batch.value, { threadId, issues })
      ? previous + 1
      : previous;
  }).pipe(Atom.withLabel(`issue-links:change-signal:${key}`));
});

const signalFor = (
  environmentId: EnvironmentId,
  threadId: string | null,
  issues: ReadonlyArray<IssueKey>,
) =>
  changeSignal(
    JSON.stringify({ environmentId, threadId, issues: issues.map(issueKeyString).toSorted() }),
  );

export const issueLinkEnvironment = {
  forThread: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issue-links:for-thread",
    tag: ISSUE_LINKS_WS_METHODS.forThread,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId, input }) => signalFor(environmentId, input.threadId, []),
  }),
  /** Threads for a page of Issues in one read; Issue rows and computed status use this. */
  threadsForIssues: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issue-links:threads-for-issues",
    tag: ISSUE_LINKS_WS_METHODS.threadsForIssues,
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId, input }) => signalFor(environmentId, null, input.issues),
  }),
  link: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-links:link",
    tag: ISSUE_LINKS_WS_METHODS.link,
  }),
  unlink: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-links:unlink",
    tag: ISSUE_LINKS_WS_METHODS.unlink,
  }),
};
