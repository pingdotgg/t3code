// Issues and pull requests as a workflow file sees them: triggers, calls for inside a step, and a
// wait on a pull request for the body.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { checkOptions } from "./options.ts";
import { issuesOpened, pullRequestsOpened } from "./triggers.ts";
import type { InRun } from "./workflow.ts";
import { waitAs } from "./workflow.ts";
import {
  type IssueAddress,
  type PullRequestAddress,
  PullRequestStanding,
  type PullRequestUntil,
  type PullRequestWatch,
  WorkflowForge,
} from "./WorkflowForge.ts";

const forge = <A, E>(use: (forge: WorkflowForge["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(WorkflowForge, use);

/**
 * The project's issues, in whichever tracker it uses. `opened` is a trigger; the rest are for
 * inside `step` or `onEnd`. An issue is named by what a trigger or `list` gave, or by
 * `{ project, url }`.
 */
export const issues = {
  opened: issuesOpened,
  list: (query: Parameters<WorkflowForge["Service"]["issues"]["list"]>[0]) => {
    checkOptions("issues.list", query, [
      "project",
      "state",
      "labels",
      "query",
      "assignee",
      "sort",
      "limit",
    ]);
    return forge((all) => all.issues.list(query));
  },
  read: (issue: IssueAddress) => forge((all) => all.issues.read(issue)),
  comment: (issue: IssueAddress, body: string) => forge((all) => all.issues.comment(issue, body)),
  /** Move the issue to one of its `states`, as `read` lists them. */
  setState: (issue: IssueAddress, state: string) =>
    forge((all) => all.issues.setState(issue, state)),
  create: (input: Parameters<WorkflowForge["Service"]["issues"]["create"]>[0]) => {
    checkOptions("issues.create", input, ["project", "title", "body", "labels", "assignees"]);
    return forge((all) => all.issues.create(input));
  },
};

/**
 * The project's pull requests on its git host. `opened` is a trigger; the rest are for inside
 * `step` or `onEnd`. A pull request is named by what a trigger or `list` gave, or by
 * `{ project, url }`.
 */
export const pullRequests = {
  opened: pullRequestsOpened,
  list: (query: Parameters<WorkflowForge["Service"]["pullRequests"]["list"]>[0]) => {
    checkOptions("pullRequests.list", query, ["project", "state", "query", "limit"]);
    return forge((all) => all.pullRequests.list(query));
  },
  read: (pullRequest: PullRequestAddress) => forge((all) => all.pullRequests.read(pullRequest)),
  comment: (pullRequest: PullRequestAddress, body: string) =>
    forge((all) => all.pullRequests.comment(pullRequest, body)),
  /** `merge`, `close`, `ready`, `update-branch` and the host's other actions on a pull request. */
  act: (
    pullRequest: PullRequestAddress,
    action: Parameters<WorkflowForge["Service"]["pullRequests"]["act"]>[1],
    options?: Parameters<WorkflowForge["Service"]["pullRequests"]["act"]>[2],
  ) => {
    checkOptions("pullRequests.act", options, ["mergeMethod"]);
    return forge((all) => all.pullRequests.act(pullRequest, action, options));
  },
  /**
   * Wait in the body until the pull request gets somewhere, without holding anything: `checks`
   * until none of its checks is still running, `merged` or `closed` until it is no longer open.
   * A pull request that is merged or closed ends any of them. Gives where it stands, or nothing
   * after `timeout`. The host is asked about once a minute.
   */
  wait: (
    name: string,
    pullRequest: PullRequestAddress,
    options: { readonly until: PullRequestUntil; readonly timeout?: Duration.Input },
  ): Effect.Effect<Option.Option<PullRequestStanding>, never, InRun> => {
    checkOptions(`pullRequests.wait("${name}")`, options, ["until", "timeout"]);
    return Effect.orDie(
      waitAs("wait", name, {
        returns: PullRequestStanding,
        timeout: options.timeout,
        watch: {
          kind: "pullRequest",
          until: options.until,
          // Only the address: a listing's row carries far more than a wait needs to keep.
          pullRequest:
            "url" in pullRequest && "project" in pullRequest
              ? { project: pullRequest.project, url: pullRequest.url }
              : {
                  projectId: pullRequest.projectId,
                  host: pullRequest.host,
                  repository: pullRequest.repository,
                  number: pullRequest.number,
                },
        } satisfies PullRequestWatch,
      }),
    );
  },
};
