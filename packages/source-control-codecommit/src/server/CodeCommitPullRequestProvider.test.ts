import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, VcsProcessExitError } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
import { driver } from "./driver.ts";
import * as Provider from "./CodeCommitPullRequestProvider.ts";

const testHost = (options: TestSourceControlHost.TestSourceControlHostOptions) =>
  TestSourceControlHost.layer({
    ...options,
    git: {
      readConfigValue: () => Effect.succeed(null),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      ...options.git,
    },
  });
const ref = {
  cwd: "/repo",
  host: "git-codecommit.us-east-1.amazonaws.com",
  repository: "v1/repos/Repo",
};
const fixture = (id: string, state = "OPEN", merged = false, repository = "Repo") => ({
  pullRequest: {
    pullRequestId: id,
    title: `Change ${id}`,
    revisionId: "revision-1",
    description: "Repository handoff notes",
    authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
    creationDate: 1738540800,
    lastActivityDate: "2025-02-03T04:05:06Z",
    pullRequestStatus: state,
    pullRequestTargets: [
      {
        repositoryName: repository,
        sourceReference: "refs/heads/docs/handoff",
        destinationReference: "refs/heads/main",
        sourceCommit: "a".repeat(40),
        destinationCommit: "b".repeat(40),
        mergeBase: "b".repeat(40),
        mergeMetadata: { isMerged: merged },
      },
    ],
  },
});

const readResponse = (args: ReadonlyArray<string>) => {
  switch (args[1]) {
    case "get-caller-identity":
      return {
        Account: "123456789012",
        Arn: "arn:aws:sts::123456789012:assumed-role/Developer/bob",
      };
    case "get-pull-request-approval-states":
      return { approvals: [] };
    case "evaluate-pull-request-approval-rules":
      return {
        evaluation: {
          approved: true,
          overridden: false,
          approvalRulesSatisfied: [],
          approvalRulesNotSatisfied: [],
        },
      };
    case "get-merge-conflicts":
      return { mergeable: true };
    case "describe-pull-request-events":
      return { pullRequestEvents: [] };
    case "get-differences":
      return { differences: [] };
    case "get-commit": {
      const id = args[args.indexOf("--commit-id") + 1];
      return {
        commit: {
          commitId: id,
          parents: id === "a".repeat(40) ? ["b".repeat(40)] : [],
          message: "Handoff",
          committer: { date: "1738540800 +0000" },
        },
      };
    }
    default:
      return undefined;
  }
};

it.effect(
  "edits PRs, posts and edits scoped comments, replies, and pins approvals to the current revision",
  () => {
    const writes: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    const viewer = "arn:aws:sts::123456789012:assumed-role/Developer/bob";
    return Effect.gen(function* () {
      const api = yield* Provider.make;
      const input = { ...ref, number: 7 };
      yield* api.updateChangeRequest!({
        ...input,
        title: "Handoff notes",
        body: "Setup and recovery guidance",
      });
      yield* api.comment({ ...input, body: "Keep setup and recovery guidance together." });
      yield* api.submitReview({
        ...input,
        verdict: "comment",
        body: "",
        comments: [
          {
            path: "new.md",
            oldPath: "old.md",
            body: "Keep the prerequisite explicit.",
            position: { kind: "context", oldLine: 4, newLine: 8, side: "left" },
          },
        ],
      });
      yield* api.replyToThread({ ...input, threadId: "own", body: "The prerequisite is covered." });
      yield* api.updateComment!({
        ...input,
        commentId: "own",
        kind: "issue-comment",
        body: "Setup and recovery guidance belong together.",
      });
      yield* api.submitReview({ ...input, verdict: "approve", body: "", comments: [] });
      yield* api.submitReview({ ...input, verdict: "revoke-approval", body: "", comments: [] });
      const posts = writes.filter((write) => write.operation === "post-comment-for-pull-request");
      assert.strictEqual(posts[0]!.payload.beforeCommitId, "b".repeat(40));
      assert.strictEqual(posts[0]!.payload.afterCommitId, "a".repeat(40));
      assert.deepStrictEqual(posts[1]!.payload.location, {
        filePath: "old.md",
        filePosition: 4,
        relativeFileVersion: "BEFORE",
      });
      assert.deepStrictEqual(
        writes
          .filter((write) => write.operation === "update-pull-request-approval-state")
          .map((write) => write.payload),
        [
          { pullRequestId: "7", revisionId: "revision-1", approvalState: "APPROVE" },
          { pullRequestId: "7", revisionId: "revision-1", approvalState: "REVOKE" },
        ],
      );
      const before = writes.length;
      for (const commentId of ["foreign", "missing"]) {
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              api.updateComment!({
                ...input,
                commentId,
                kind: "issue-comment",
                body: "No rewrite",
              }),
            ),
          ),
        );
      }
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            api.replyToThread({ ...input, threadId: "missing", body: "No reply" }),
          ),
        ),
      );
      assert.strictEqual(writes.length, before);
    }).pipe(
      Effect.provide(
        testHost({
          process: {
            run: ({ args }) => {
              let result: unknown = readResponse(args);
              if (args[1] === "get-pull-request") result = fixture("7");
              if (args[1] === "get-comments-for-pull-request")
                result = {
                  commentsForPullRequestData: [
                    {
                      repositoryName: "Repo",
                      comments: [
                        {
                          commentId: "own",
                          content: "Original",
                          creationDate: 1738540800,
                          authorArn: viewer,
                        },
                        {
                          commentId: "foreign",
                          content: "Keep",
                          creationDate: 1738540800,
                          authorArn: fixture("7").pullRequest.authorArn,
                        },
                      ],
                    },
                  ],
                };
              if (args.includes("--cli-input-json")) {
                const payload = JSON.parse(args[args.indexOf("--cli-input-json") + 1]!) as Record<
                  string,
                  unknown
                >;
                writes.push({ operation: args[1]!, payload });
                result = {};
              }
              return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(result)));
            },
          },
        }),
      ),
    );
  },
);

it.effect.each(["merge", "squash", "fast-forward"] as const)(
  "merges using %s with a pinned source commit and refuses reopening",
  (method) => {
    let status = "OPEN";
    let merged = false;
    const writes: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    return Effect.gen(function* () {
      const api = yield* Provider.make;
      const input = { ...ref, number: 7 };
      assert.strictEqual(
        (yield* api.runAction({ ...input, action: "merge", mergeMethod: method }))?.state,
        "merged",
      );
      const operation =
        method === "merge"
          ? "merge-pull-request-by-three-way"
          : method === "squash"
            ? "merge-pull-request-by-squash"
            : "merge-pull-request-by-fast-forward";
      assert.deepStrictEqual(writes.at(-1), {
        operation,
        payload: {
          pullRequestId: "7",
          repositoryName: "Repo",
          sourceCommitId: "a".repeat(40),
          ...(method === "fast-forward" ? {} : { conflictDetailLevel: "LINE_LEVEL" }),
        },
      });
      const refused = yield* Effect.result(api.runAction({ ...input, action: "reopen" }));
      assert.isTrue(Result.isFailure(refused));
      assert.strictEqual(writes.length, 1);
    }).pipe(
      Effect.provide(
        testHost({
          process: {
            run: ({ args }) => {
              if (args[1] === "get-pull-request")
                return Effect.succeed(
                  TestSourceControlHost.processOutput(JSON.stringify(fixture("7", status, merged))),
                );
              const payload = JSON.parse(args[args.indexOf("--cli-input-json") + 1]!) as Record<
                string,
                unknown
              >;
              writes.push({ operation: args[1]!, payload });
              if (args[1] === "update-pull-request-status")
                status = String(payload.pullRequestStatus);
              else {
                status = "CLOSED";
                merged = true;
              }
              return Effect.succeed(TestSourceControlHost.processOutput("{}"));
            },
          },
        }),
      ),
    );
  },
);

it.effect("refuses self-approval before posting any review comments", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const api = yield* Provider.make;
    const denied = yield* Effect.result(
      api.submitReview({ ...ref, number: 7, verdict: "approve", body: "Feedback", comments: [] }),
    );
    assert.isTrue(Result.isFailure(denied));
    if (Result.isFailure(denied)) assert.include(denied.failure.detail, "your own pull request");
    assert.deepStrictEqual(calls.sort(), ["get-caller-identity", "get-pull-request"]);
  }).pipe(
    Effect.provide(
      testHost({
        process: {
          run: ({ args }) => {
            calls.push(args[1]!);
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify(
                  args[1] === "get-pull-request"
                    ? fixture("7")
                    : { Account: "123456789012", Arn: fixture("7").pullRequest.authorArn },
                ),
              ),
            );
          },
        },
      }),
    ),
  );
});

it.effect(
  "uses a helper remote's profile for PR reads and refuses a conflicting selected profile",
  () => {
    const profiles: string[] = [];
    return Effect.gen(function* () {
      const api = yield* Provider.make;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* api.getViewer(ref);
      yield* api.getChangeRequestSummary!({ ...ref, number: 7 });
      assert.deepStrictEqual(profiles, ["self", "self"]);
      yield* settings.update({
        sourceControlHosts: { "aws-codecommit": { profile: "other", region: "us-east-1" } },
      });
      const mismatch = yield* Effect.result(api.getChangeRequestSummary!({ ...ref, number: 7 }));
      assert.isTrue(Result.isFailure(mismatch));
      if (Result.isFailure(mismatch)) assert.include(mismatch.failure.detail, "profile conflicts");
      assert.strictEqual(profiles.length, 2);
    }).pipe(
      Effect.provide(
        testHost({
          git: { readConfigValue: () => Effect.succeed("codecommit://self@Repo") },
          process: {
            run: ({ args }) => {
              profiles.push(args[args.indexOf("--profile") + 1]!);
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify(
                    args[1] === "get-pull-request" ? fixture("7") : readResponse(args),
                  ),
                ),
              );
            },
          },
        }),
      ),
    );
  },
);

it.effect.each([
  ["AccessDeniedException", "forbidden"],
  ["ExpiredTokenException", "unauthenticated"],
  ["ThrottlingException", "rate-limited"],
  ["PullRequestDoesNotExistException", "not-found"],
] as const)("classifies AWS %s as %s without exposing stderr", ([code, reason]) =>
  Effect.gen(function* () {
    const api = yield* Provider.make;
    const result = yield* Effect.result(api.getChangeRequestSummary!({ ...ref, number: 7 }));
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure.reason, reason);
      assert.include(result.failure.detail, code);
      assert.notInclude(result.failure.detail, "private diagnostic");
    }
  }).pipe(
    Effect.provide(
      testHost({
        process: {
          run: () =>
            Effect.succeed(
              TestSourceControlHost.processOutput("", {
                exitCode: ChildProcessSpawner.ExitCode(254),
                stderr: `An error occurred (${code}) when calling operation: private diagnostic`,
              }),
            ),
        },
      }),
    ),
  ),
);

it.effect(
  "reads details and paged comments while rejecting pull requests from another repository",
  () => {
    return Effect.gen(function* () {
      const api = yield* Provider.make;
      const input = { ...ref, number: 7 };
      const detail = yield* api.getChangeRequest(input);
      assert.strictEqual(detail.body, "Repository handoff notes");
      assert.strictEqual(detail.headBranch, "docs/handoff");
      assert.strictEqual(detail.headSha, "a".repeat(40));
      const activity = yield* api.getChangeRequestActivity(input);
      assert.deepStrictEqual(
        activity.comments.map((comment) => [comment.id, comment.body, comment.path]),
        [["first", "Handoff notes", null]],
      );
      assert.strictEqual(activity.commentsTruncated, false);
      assert.strictEqual(activity.reviewThreads[0]?.path, "README.md");
      assert.strictEqual(activity.reviewThreads[0]?.comments[0]?.body, "Clarify setup");
      const mismatch = yield* Effect.result(api.getChangeRequest({ ...ref, number: 8 }));
      assert.isTrue(Result.isFailure(mismatch));
      if (Result.isFailure(mismatch))
        assert.strictEqual(mismatch.failure.detail, "Pull request repository mismatch");
    }).pipe(
      Effect.provide(
        testHost({
          git: { execute: () => Effect.succeed(TestSourceControlHost.processOutput("true\n")) },
          process: {
            run: ({ args }) => {
              const extra = readResponse(args);
              if (extra !== undefined)
                return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(extra)));
              if (args[1] === "get-comments-for-pull-request" && args.includes("--repository-name"))
                return Effect.fail(
                  new VcsProcessExitError({
                    operation: "CodeCommit.execute",
                    command: "aws",
                    cwd: ref.cwd,
                    exitCode: 254,
                    detail: "CommitIdRequiredException: A commit ID is required.",
                  }),
                );
              const result =
                args[1] === "get-pull-request"
                  ? fixture(
                      args.includes("8") ? "8" : "7",
                      "OPEN",
                      false,
                      args.includes("8") ? "Other" : "Repo",
                    )
                  : args.includes("--next-token")
                    ? {
                        commentsForPullRequestData: [
                          {
                            repositoryName: "Repo",
                            location: { filePath: "README.md" },
                            comments: [
                              {
                                commentId: "inline",
                                authorArn: fixture("7").pullRequest.authorArn,
                                content: "Clarify setup",
                                creationDate: 1738540800,
                              },
                            ],
                          },
                        ],
                      }
                    : {
                        commentsForPullRequestData: [
                          {
                            repositoryName: "Repo",
                            comments: [
                              {
                                commentId: "first",
                                authorArn: fixture("7").pullRequest.authorArn,
                                content: "Handoff notes",
                                creationDate: 1738540800,
                              },
                            ],
                          },
                        ],
                        nextToken: "next",
                      };
              return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(result)));
            },
          },
        }),
      ),
    );
  },
);

it.effect.each(["us-east-1", "us-gov-west-1"] as const)(
  "holds the verified account and profile throughout routed reads and writes in %s",
  (region) => {
    const routedRef = { ...ref, host: `git-codecommit.${region}.amazonaws.com` };
    const profiles: string[] = [];
    return Effect.gen(function* () {
      const api = yield* Provider.make;
      const hostSettings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      const run = () =>
        api.withVerifiedCredential!(routedRef, (identity) =>
          Effect.gen(function* () {
            assert.strictEqual(identity.accountId, "123456789012");
            assert.strictEqual(identity.viewer, fixture("7").pullRequest.authorArn);
            yield* hostSettings.update({
              sourceControlHosts: { "aws-codecommit": { profile: "changed", region: "us-east-1" } },
            });
            yield* api.getChangeRequestSummary!({ ...routedRef, number: 7 });
            yield* api.comment({ ...routedRef, number: 7, body: "Update" });
            return identity.credentialFingerprint;
          }),
        );
      const before = yield* run();
      assert.deepStrictEqual([...new Set(profiles)], ["original"]);
      const after = yield* run();
      assert.notStrictEqual(before, after);
      const error = yield* Effect.result(
        api.withVerifiedCredential!(routedRef, () => Effect.fail("consumer-error")),
      );
      assert.deepStrictEqual(error, Result.fail("consumer-error"));
    }).pipe(
      Effect.provide(
        testHost({
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sourceControlHosts: { "aws-codecommit": { profile: "original", region: "us-east-1" } },
          },
          process: {
            run: ({ args }) => {
              assert.strictEqual(args[args.indexOf("--region") + 1], region);
              profiles.push(args[args.indexOf("--profile") + 1]!);
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify(
                    args[1] === "get-caller-identity"
                      ? { Account: "123456789012", Arn: fixture("7").pullRequest.authorArn }
                      : fixture("7"),
                  ),
                ),
              );
            },
          },
        }),
      ),
    );
  },
);

it.effect(
  "browses CodeCommit PRs through the registered driver with pagination and state filtering",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    const awsToken = `${"A".repeat(900)}+/==`;
    const skippedToken = "closed-only-page";
    return Effect.gen(function* () {
      const instance = yield* driver.make;
      assert.isNotNull(instance.pullRequests);
      const api = instance.pullRequests!;
      const input = {
        ...ref,
        state: "merged" as const,
        involvement: "all" as const,
        viewer: "alice",
        limit: 20,
      };
      const first = yield* api.listChangeRequests(input);
      assert.deepStrictEqual(
        first.items.map((pr) => [pr.number, pr.state]),
        [[2, "merged"]],
      );
      assert.strictEqual(first.continues, true);
      assert.isDefined(first.resumeAfter);
      assert.match(first.resumeAfter!, /^[\w.:~+-]{1,128}$/u);
      const next = yield* api.listChangeRequests({
        ...input,
        cursor: {
          updatedBefore: "2025-02-03T04:05:06Z",
          delivered: 1,
          resumeAfter: first.resumeAfter,
        },
      });
      assert.deepStrictEqual(
        next.items.map((pr) => pr.number),
        [3],
      );
      assert.strictEqual(next.continues, false);
      assert.isTrue(calls.some((args) => args[args.indexOf("--next-token") + 1] === awsToken));
      const callsBeforeInvalidCursor = calls.length;
      for (const resumeAfter of [first.resumeAfter!, "expired"]) {
        const invalid = yield* Effect.result(
          api.listChangeRequests({
            ...input,
            state: "all",
            cursor: { updatedBefore: "2025-02-03T04:05:06Z", delivered: 1, resumeAfter },
          }),
        );
        assert.isTrue(Result.isFailure(invalid));
        if (Result.isFailure(invalid))
          assert.include(invalid.failure.accessHint, "Refresh the list");
      }
      assert.strictEqual(calls.length, callsBeforeInvalidCursor);
      const all = yield* api.listChangeRequests({ ...input, state: "all", limit: 100 });
      assert.deepStrictEqual(
        all.items.map((pr) => [pr.number, pr.state]),
        [
          [2, "merged"],
          [1, "closed"],
        ],
      );
      const allCalls = calls.filter(
        (args) => args[1] === "list-pull-requests" && !args.includes("--pull-request-status"),
      );
      assert.strictEqual(allCalls.length, 1);
      assert.strictEqual(allCalls[0]![allCalls[0]!.indexOf("--max-results") + 1], "20");
      assert.strictEqual(first.items[0]!.author?.login, fixture("2").pullRequest.authorArn);
      assert.strictEqual(first.items[0]!.createdAt, "2025-02-03T00:00:00.000Z");
      assert.isTrue(
        calls.every(
          (args) =>
            args.includes("work") && args.includes("us-east-1") && !args.includes("eu-west-1"),
        ),
      );
      assert.isTrue(
        calls.some((args) => args.includes("--pull-request-status") && args.includes("CLOSED")),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          SourceControlRateLimit.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected HTTP request")),
          ),
          testHost({
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sourceControlHosts: { "aws-codecommit": { profile: "work", region: "eu-west-1" } },
            },
            process: {
              run: ({ args }) => {
                calls.push(args);
                const result =
                  args[1] === "list-pull-requests"
                    ? args.includes(awsToken)
                      ? { pullRequestIds: ["3"] }
                      : args.includes(skippedToken) || !args.includes("--pull-request-status")
                        ? { pullRequestIds: ["1", "2"], nextToken: awsToken }
                        : { pullRequestIds: ["1"], nextToken: skippedToken }
                    : fixture(
                        args[args.indexOf("--pull-request-id") + 1]!,
                        "CLOSED",
                        !args.includes("1"),
                      );
                return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(result)));
              },
            },
          }),
        ),
      ),
    );
  },
);

it.effect.each(["before-operation", "before-write"] as const)(
  "refuses routed writes when the selected profile changes AWS accounts %s",
  (phase) => {
    let account = "123456789012";
    let writes = 0;
    return Effect.gen(function* () {
      const api = yield* Provider.make;
      const result = yield* Effect.result(
        api.withVerifiedCredential!(ref, () =>
          Effect.gen(function* () {
            if (phase === "before-operation") account = "234567890123";
            return yield* api.comment({ ...ref, number: 7, body: "Update" });
          }),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(writes, 0);
    }).pipe(
      Effect.provide(
        testHost({
          process: {
            run: ({ args }) => {
              if (args.includes("--cli-input-json")) writes++;
              if (phase === "before-write" && args[1] === "get-pull-request")
                account = "234567890123";
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  JSON.stringify(
                    args[1] === "get-caller-identity"
                      ? { Account: account, Arn: "arn:aws:iam::123456789012:user/alice" }
                      : args[1] === "get-pull-request"
                        ? fixture("7")
                        : {},
                  ),
                ),
              );
            },
          },
        }),
      ),
    );
  },
);
