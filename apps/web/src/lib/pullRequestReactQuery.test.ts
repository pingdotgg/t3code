import { describe, expect, it } from "vitest";

import { EnvironmentId, ProjectId, type PullRequestListResult } from "@t3tools/contracts";

import {
  pullRequestDiffInfiniteQueryOptions,
  pullRequestListInfiniteQueryOptions,
  pullRequestMutationKeys,
  pullRequestQueryKeys,
} from "./pullRequestReactQuery";

const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const PROJECT_ID = ProjectId.make("project-a");

describe("pullRequestReactQuery", () => {
  it("scopes list keys by environment and filters", () => {
    expect(
      pullRequestQueryKeys.list(ENVIRONMENT_ID, {
        state: "open",
        projectId: PROJECT_ID,
      }),
    ).not.toEqual(
      pullRequestQueryKeys.list(ENVIRONMENT_ID, {
        state: "closed",
        projectId: PROJECT_ID,
      }),
    );
  });

  it("does not put continuation cursors in the infinite query key", () => {
    const options = pullRequestListInfiniteQueryOptions({
      environmentId: ENVIRONMENT_ID,
      request: { state: "open", projectId: PROJECT_ID },
    });

    expect(options.queryKey).toEqual(
      pullRequestQueryKeys.list(ENVIRONMENT_ID, { state: "open", projectId: PROJECT_ID }),
    );
  });

  it("stops a cursorless truncated listing", () => {
    const options = pullRequestListInfiniteQueryOptions({
      environmentId: ENVIRONMENT_ID,
      request: { state: "open", projectId: PROJECT_ID },
    });
    const page = {
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: true,
      nextCursors: {},
    } satisfies PullRequestListResult;

    expect(options.getNextPageParam(page, [page], null, [null])).toBeUndefined();
  });

  it("does not put diff continuation cursors in the infinite query key", () => {
    const options = pullRequestDiffInfiniteQueryOptions({
      environmentId: ENVIRONMENT_ID,
      request: {
        projectId: PROJECT_ID,
        repository: "t3tools/t3code",
        number: 42,
      },
    });

    expect(options.queryKey).toEqual(
      pullRequestQueryKeys.diffInfinite(ENVIRONMENT_ID, {
        projectId: PROJECT_ID,
        repository: "t3tools/t3code",
        number: 42,
      }),
    );
  });

  it("scopes mutation keys by environment", () => {
    expect(pullRequestMutationKeys.comment(ENVIRONMENT_ID)).not.toEqual(
      pullRequestMutationKeys.comment(null),
    );
  });
});
