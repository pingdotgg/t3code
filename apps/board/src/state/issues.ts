import { createIssueTrackerEnvironmentAtoms } from "@t3tools/client-runtime/state/issue-trackers";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type IssueDetail,
  type IssueRef,
  WS_METHODS,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { type IssueBrief, type TrackerCall } from "../issues/issueLinks";
import { failureText } from "../settings/failureText";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);
export const issueTrackerEnvironment = createIssueTrackerEnvironmentAtoms(connectionAtomRuntime);

const readDetail = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:issues:read-detail",
  tag: WS_METHODS.issuesDetail,
});

/** Pages of older comments read after the detail's own page, which bounds a very long thread. */
const MAX_COMMENT_PAGES = 5;

const briefOf = (detail: IssueDetail, comments: IssueDetail["comments"]): IssueBrief => ({
  tracker: detail.tracker,
  displayKey: detail.displayKey,
  title: detail.title,
  url: detail.url,
  state: detail.state.name,
  author: detail.author?.login ?? null,
  body: detail.body,
  comments: comments.map((comment) => ({
    author: comment.author?.login ?? null,
    createdAt: comment.createdAt,
    body: comment.body,
  })),
});

/** The issue's description and its comments, oldest first. A thread longer than MAX_COMMENT_PAGES pages past the detail loses its oldest comments. */
export async function readIssueBrief(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  ref: IssueRef,
): Promise<IssueBrief> {
  const detail = await runAtomCommand(
    registry,
    readDetail,
    { environmentId, input: ref },
    { reportFailure: false },
  );
  if (detail._tag !== "Success") throw new Error(failureText(detail));
  const olderPages: Array<IssueDetail["comments"]> = [];
  let cursor = detail.value.commentsCursor;
  for (let page = 0; cursor !== null && page < MAX_COMMENT_PAGES; page += 1) {
    const older = await runAtomCommand(
      registry,
      issueEnvironment.comments,
      { environmentId, input: { ...ref, cursor } },
      { reportFailure: false },
    );
    if (older._tag !== "Success") throw new Error(failureText(older));
    olderPages.unshift(older.value.comments);
    cursor = older.value.nextCursor;
  }
  return briefOf(detail.value, [...olderPages.flat(), ...detail.value.comments]);
}

export async function runTrackerCall(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  call: TrackerCall,
): Promise<string> {
  const options = { reportFailure: false } as const;
  switch (call.operation) {
    case "create": {
      const result = await runAtomCommand(
        registry,
        issueEnvironment.create,
        { environmentId, input: call.input },
        options,
      );
      if (result._tag !== "Success") throw new Error(failureText(result));
      return `Created ${result.value.displayKey}: ${result.value.url}`;
    }
    case "setState": {
      const result = await runAtomCommand(
        registry,
        issueEnvironment.setState,
        { environmentId, input: call.input },
        options,
      );
      if (result._tag !== "Success") throw new Error(failureText(result));
      return `Moved ${call.input.key} to "${call.input.state}"`;
    }
    case "comment": {
      const result = await runAtomCommand(
        registry,
        issueEnvironment.comment,
        { environmentId, input: call.input },
        options,
      );
      if (result._tag !== "Success") throw new Error(failureText(result));
      return `Commented on ${call.input.key}`;
    }
  }
}
