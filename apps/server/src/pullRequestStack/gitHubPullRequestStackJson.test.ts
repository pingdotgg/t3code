import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeGitHubLocalStackJson,
  decodeGitHubRemoteStacksJson,
} from "./gitHubPullRequestStackJson.ts";

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("GitHub remote stack JSON", () => {
  it("keeps GitHub's bottom-to-top pull request order", () => {
    const [stack] = expectSuccess(
      decodeGitHubRemoteStacksJson(
        JSON.stringify([
          {
            id: 41,
            number: 7,
            url: "https://api.github.com/repos/acme/app/stacks/7",
            base: { ref: "main" },
            open: true,
            pull_requests: [
              {
                number: 10,
                state: "open",
                draft: false,
                merged_at: null,
                head: { ref: "auth", sha: "a1" },
              },
              {
                number: 11,
                state: "open",
                draft: true,
                merged_at: null,
                head: { ref: "api", sha: "b2" },
              },
            ],
          },
        ]),
      ),
    );

    expect(stack?.steps).toEqual([
      {
        position: 1,
        pullRequestNumber: 10,
        branch: "auth",
        state: "open",
        draft: false,
      },
      {
        position: 2,
        pullRequestNumber: 11,
        branch: "api",
        state: "open",
        draft: true,
      },
    ]);
  });

  it("uses merged_at as the merged source of truth", () => {
    const [stack] = expectSuccess(
      decodeGitHubRemoteStacksJson(
        JSON.stringify([
          {
            id: 41,
            number: 7,
            url: "https://api.github.com/repos/acme/app/stacks/7",
            base: { ref: "main" },
            open: true,
            pull_requests: [
              {
                number: 10,
                state: "closed",
                draft: false,
                merged_at: "2026-08-13T00:00:00Z",
                head: { ref: "auth", sha: "a1" },
              },
            ],
          },
        ]),
      ),
    );

    expect(stack?.steps[0]?.state).toBe("merged");
  });
});

describe("GitHub local stack JSON", () => {
  it("normalizes branch health and current position", () => {
    const stack = expectSuccess(
      decodeGitHubLocalStackJson(
        JSON.stringify({
          trunk: "main",
          currentBranch: "api",
          branches: [
            {
              name: "auth",
              head: "a1",
              base: "main",
              isCurrent: false,
              isMerged: true,
              isQueued: false,
              needsRebase: false,
              pr: {
                number: 10,
                url: "https://github.com/acme/app/pull/10",
                state: "MERGED",
              },
            },
            {
              name: "api",
              head: "b2",
              base: "auth",
              isCurrent: true,
              isMerged: false,
              isQueued: true,
              needsRebase: true,
              pr: {
                number: 11,
                url: "https://github.com/acme/app/pull/11",
                state: "QUEUED",
              },
            },
          ],
        }),
      ),
    );

    expect(stack.steps.map((step) => [step.position, step.pullRequest?.state])).toEqual([
      [1, "merged"],
      [2, "queued"],
    ]);
    expect(stack.steps[1]?.isCurrent).toBe(true);
    expect(stack.steps[1]?.needsRebase).toBe(true);
  });

  it("accepts legacy pull requests without a stored URL", () => {
    const stack = expectSuccess(
      decodeGitHubLocalStackJson(
        JSON.stringify({
          trunk: "main",
          currentBranch: "auth",
          branches: [
            {
              name: "auth",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
              pr: { number: 10, state: "OPEN" },
            },
          ],
        }),
      ),
    );

    expect(stack.steps[0]?.pullRequest).toEqual({ number: 10, state: "open" });
  });

  it("fails closed on malformed command output", () => {
    expect(Result.isFailure(decodeGitHubLocalStackJson("{not-json"))).toBe(true);
  });

  it("fails closed on an unknown pull request state", () => {
    expect(
      Result.isFailure(
        decodeGitHubLocalStackJson(
          JSON.stringify({
            trunk: "main",
            currentBranch: "auth",
            branches: [
              {
                name: "auth",
                isCurrent: true,
                isMerged: false,
                isQueued: false,
                needsRebase: false,
                pr: { number: 10, url: "https://github.com/acme/app/pull/10", state: "UNKNOWN" },
              },
            ],
          }),
        ),
      ),
    ).toBe(true);
  });
});
