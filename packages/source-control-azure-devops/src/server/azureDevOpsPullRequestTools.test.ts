import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAzureDevOpsPullRequestTools } from "./azureDevOpsPullRequestTools.ts";
import { AzureDevOpsPullRequestReadError } from "./AzureDevOpsPullRequestCli.ts";

const target = { cwd: "/w", location: { project: "example", repository: "sandbox" }, number: 1352 };
const pr = {
  pullRequestId: 1352,
  status: "active",
  isDraft: false,
  reviewers: [
    {
      id: "reader",
      uniqueName: "reader@example.com",
      displayName: "Reader",
      vote: 5,
      isRequired: true,
    },
  ],
  labels: [{ id: "tag-id", name: "test" }],
  repository: {
    id: "repo-id",
    webUrl: "https://dev.azure.com/example/project/_git/sandbox",
    project: { id: "project-id" },
  },
  lastMergeSourceCommit: { commitId: "source-sha" },
  lastMergeCommit: { commitId: "preview-sha" },
};
const fixture = (
  overrides = {},
  branchOperation = { cherryPickId: 1, status: "completed" },
  policySettings?: Record<string, boolean>,
  statuses: ReadonlyArray<Record<string, unknown>> = [],
  policyContext?: Record<string, unknown>,
) => {
  const commands: ReadonlyArray<string>[] = [];
  const writes: Parameters<Parameters<typeof makeAzureDevOpsPullRequestTools>[0]["write"]>[0][] =
    [];
  const tools = makeAzureDevOpsPullRequestTools({
    listIterations: () =>
      Effect.succeed([{ id: 1, headCommit: "source-sha", mergeBaseCommit: "base-sha" }]),
    readItemContent: () => Effect.die("unused"),
    resolveIdentities: () =>
      Effect.succeed({
        stdout: JSON.stringify({ value: [{ id: "team", descriptor: "team-descriptor" }] }),
      }),
    uploadAttachment: () =>
      Effect.succeed({
        stdout: JSON.stringify({ displayName: "test.txt", url: "https://example.com/test.txt" }),
      }),
    subscriptions: () => Effect.succeed({ stdout: JSON.stringify({ value: [] }) }),
    identity: () => Effect.succeed({ id: "reader", login: "reader@example.com", name: "Reader" }),
    execute: (input) =>
      Effect.sync(() => {
        commands.push(input.args);
        return {
          stdout: JSON.stringify(
            input.args.includes("Subscriptions") ||
              input.args.includes("refsFavorites") ||
              input.args.includes("pullRequestAttachments")
              ? { value: [] }
              : input.args.includes("pullRequestStatuses")
                ? { value: statuses }
                : input.args.includes("pullRequestLabels")
                  ? { value: pr.labels }
                  : input.args.includes("pullRequestReviewers")
                    ? { value: pr.reviewers }
                    : input.args.includes("show")
                      ? { ...pr, ...overrides }
                      : input.args.includes("policy")
                        ? [
                            {
                              evaluationId: "evaluation",
                              status: "approved",
                              ...(policyContext
                                ? { status: "queued", context: policyContext }
                                : {}),
                              configuration: {
                                id: 7,
                                isBlocking: policySettings !== undefined,
                                type: {
                                  displayName: "Validation",
                                  ...(policySettings
                                    ? { id: "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab" }
                                    : {}),
                                },
                                ...(policySettings ? { settings: policySettings } : {}),
                              },
                            },
                          ]
                        : [],
          ),
        };
      }),
    writeJson: (input) =>
      Effect.sync(() => {
        writes.push(input);
        return JSON.stringify(branchOperation);
      }),
    write: (input) =>
      Effect.sync(() => {
        writes.push(input);
      }),
    failure: (input) => new AzureDevOpsPullRequestReadError(input),
  });
  return { ...tools, commands, writes };
};
it.effect("reads queued checks without a state and preserves other check results", () =>
  Effect.gen(function* () {
    const states = [
      undefined,
      null,
      "notSet",
      "pending",
      "succeeded",
      "failed",
      "error",
      "notApplicable",
    ];
    const tools = fixture(
      {},
      undefined,
      undefined,
      states.map((state, index) => ({
        context: { name: `check-${index}`, genre: index === 0 ? undefined : null },
        state,
      })),
    );
    const result = yield* tools.checks({ ...target, iterationId: 1 });
    expect(result.checks).toEqual([
      expect.objectContaining({ name: "Validation", status: "success" }),
      ...[
        "pending",
        "pending",
        "pending",
        "pending",
        "success",
        "failure",
        "failure",
        "skipped",
      ].map((status, index) => ({
        name: `check-${index}`,
        description: null,
        url: null,
        status,
      })),
    ]);
  }),
);
it.effect("keeps only the latest status per context for the current update", () =>
  Effect.gen(function* () {
    const statuses = [
      {
        id: 6,
        iterationId: 10,
        context: { genre: "ci", name: "coverage" },
        state: "notApplicable",
      },
      { id: 4, iterationId: 10, context: { genre: "ci", name: "coverage" } },
      { id: 5, iterationId: 10, context: { genre: "ci", name: "coverage" }, state: "pending" },
      { id: 7, iterationId: 8, context: { genre: "ci", name: "coverage" }, state: "pending" },
      { id: 8, iterationId: 8, context: { name: "old-only" }, state: "failed" },
      { id: 9, context: { genre: "ci", name: "author" }, state: "succeeded" },
      { id: 10, context: { genre: "other", name: "coverage" }, state: "failed" },
    ];
    for (const values of [statuses, statuses.toReversed()]) {
      const tools = fixture({}, undefined, undefined, values);
      const result = yield* tools.checks({ ...target, iterationId: 10 });
      expect(result.checks).toHaveLength(4);
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "ci / coverage", status: "skipped" }),
          expect.objectContaining({ name: "ci / author", status: "success" }),
          expect.objectContaining({ name: "other / coverage", status: "failure" }),
        ]),
      );
      const nextUpdate = yield* tools.checks({ ...target, iterationId: 11 });
      expect(nextUpdate.checks.map((check) => check.name)).not.toContain("ci / coverage");
      expect(nextUpdate.checks).toHaveLength(3);
      const unknownUpdate = yield* tools.checks({ ...target, iterationId: null });
      expect(unknownUpdate.checks.find((check) => check.name === "ci / coverage")).toMatchObject({
        status: "pending",
        description: expect.stringContaining("unverified"),
      });
    }
  }),
);
it.effect("describes an expired build without claiming a queued policy is running", () =>
  Effect.gen(function* () {
    const tools = fixture({}, undefined, undefined, [], { isExpired: true });
    const result = yield* tools.checks({ ...target, iterationId: 1 });
    expect(result.checks[0]).toMatchObject({
      status: "pending",
      description: "Branch policy: queued (previous build expired; awaiting a new evaluation)",
    });
  }),
);
it.effect("retains all native completion options and completes the source commit it read", () =>
  Effect.gen(function* () {
    for (const strategy of ["noFastForward", "squash", "rebase", "rebaseMerge"] as const) {
      const tools = fixture();
      yield* tools.run({
        ...target,
        action: {
          type: "complete",
          automatic: false,
          strategy,
          deleteSourceBranch: true,
          transitionWorkItems: true,
          message: "Synthetic merge",
          bypassPolicy: false,
          bypassReason: "",
          waitForOptionalPolicies: false,
        },
      });
      expect(tools.writes).toHaveLength(1);
      expect(JSON.parse(tools.writes[0]!.body!)).toEqual({
        status: "completed",
        lastMergeSourceCommit: { commitId: "source-sha" },
        completionOptions: {
          mergeStrategy: strategy,
          deleteSourceBranch: true,
          transitionWorkItems: true,
          mergeCommitMessage: "Synthetic merge",
          bypassPolicy: false,
          bypassReason: "",
          autoCompleteIgnoreConfigIds: [7],
        },
      });
    }
  }),
);
it.effect("supports every Azure review vote and refuses voting on a draft or closed PR", () =>
  Effect.gen(function* () {
    const tools = fixture();
    for (const vote of [
      "approve",
      "approve-with-suggestions",
      "wait-for-author",
      "reject",
      "reset",
    ] as const)
      yield* tools.run({ ...target, action: { type: "vote", vote } });
    expect(tools.writes.map((write) => JSON.parse(write.body!))).toEqual(
      [10, 5, -5, -10, 0].map((vote) => ({ id: "reader", vote, isReapprove: true })),
    );
    for (const overrides of [{ isDraft: true }, { status: "abandoned" }]) {
      const denied = fixture(overrides);
      yield* denied.run({ ...target, action: { type: "vote", vote: "approve" } }).pipe(Effect.flip);
      expect(denied.writes).toHaveLength(0);
    }
  }),
);
it.effect(
  "changes reviewer requirement without resetting their vote, retargets, and links work items",
  () =>
    Effect.gen(function* () {
      const tools = fixture();
      yield* tools.run({
        ...target,
        action: { type: "reviewer-required", reviewerId: "reader", required: false },
      });
      yield* tools.run({ ...target, action: { type: "retarget", branch: "test-base" } });
      yield* tools.run({ ...target, action: { type: "work-items", ids: [12, 13], linked: true } });
      yield* tools.run({ ...target, action: { type: "work-items", ids: [12], linked: false } });
      expect(JSON.parse(tools.writes[0]!.body!)).toEqual({
        id: "reader",
        isRequired: false,
        vote: 5,
      });
      expect(tools.writes[0]!.method).toBe("PUT");
      expect(JSON.parse(tools.writes[1]!.body!)).toEqual({ targetRefName: "refs/heads/test-base" });
      expect(tools.commands).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(["work-item", "add", "12", "13"]),
          expect.arrayContaining(["work-item", "remove", "12"]),
        ]),
      );
    }),
);
it.effect(
  "reads review votes, policies and merge preview without treating optional detail failures as empty success",
  () =>
    Effect.gen(function* () {
      const tools = fixture();
      const detail = yield* tools.details(target);
      expect(detail.reviewers[0]).toMatchObject({ required: true, vote: 5 });
      expect(detail.policies[0]).toMatchObject({
        required: false,
        status: "approved",
        url: "https://dev.azure.com/example/project/_settings/repositories?repo=repo-id&_a=policiesMid",
      });
      expect(detail.mergePreviewUrl).toContain("preview-sha");
      expect(detail.warnings).toEqual([]);
    }),
);

it.effect(
  "reads tags from their collection so a tag can be removed even when PR show omits labels",
  () =>
    Effect.gen(function* () {
      const tools = fixture({ labels: null });
      expect((yield* tools.labelCandidates(target)).candidates.map((label) => label.name)).toEqual([
        "test",
      ]);
      yield* tools.setLabels({ ...target, labels: ["test"], applied: false });
      expect(tools.writes[0]).toMatchObject({
        method: "DELETE",
        routeParameters: expect.arrayContaining(["labelIdOrName=tag-id"]),
      });
    }),
);

it.effect(
  "does not let authors decline or flag their own reviews, or change another reviewer's flag",
  () =>
    Effect.gen(function* () {
      const tools = fixture({ createdBy: { id: "reader" } });
      for (const action of [
        { type: "decline-review", declined: true },
        { type: "reviewer-flag", reviewerId: "reader", flagged: true },
      ] as const)
        yield* tools.run({ ...target, action }).pipe(Effect.flip);
      expect(tools.writes).toHaveLength(0);
      const other = fixture();
      yield* other
        .run({
          ...target,
          action: { type: "reviewer-flag", reviewerId: "someone-else", flagged: true },
        })
        .pipe(Effect.flip);
      expect(other.writes).toHaveLength(0);
    }),
);

const suggestion = (input: {
  /** Where the suggestion's file has its lines at the push it was left on, and now. */
  readonly before: string;
  readonly after: string;
  readonly thread: Record<string, unknown>;
}) => {
  const writes: Parameters<Parameters<typeof makeAzureDevOpsPullRequestTools>[0]["write"]>[0][] =
    [];
  const reads: ReadonlyArray<string>[] = [];
  const items: Array<{ path: string; commit: string; project: string }> = [];
  const tools = makeAzureDevOpsPullRequestTools({
    listIterations: () =>
      Effect.succeed([
        { id: 1, headCommit: "first-sha", mergeBaseCommit: "base-sha" },
        { id: 2, headCommit: "source-sha", mergeBaseCommit: "base-sha" },
      ]),
    readItemContent: (item) =>
      Effect.sync(() => {
        items.push({ path: item.path, commit: item.commit, project: item.location.project });
        return {
          contents: item.commit === "first-sha" ? input.before : input.after,
          isBinary: false,
        };
      }),
    resolveIdentities: () => Effect.die("unused"),
    identity: () => Effect.succeed({ id: "reader", login: "reader@example.com", name: "Reader" }),
    subscriptions: () => Effect.die("unused"),
    uploadAttachment: () => Effect.die("unused"),
    execute: (command) =>
      Effect.sync(() => {
        reads.push(command.args);
        return {
          stdout: JSON.stringify(
            command.args.includes("show")
              ? {
                  ...pr,
                  sourceRefName: "refs/heads/feature",
                  forkSource: {
                    repository: { id: "source-repo", project: { id: "source-project" } },
                  },
                }
              : command.args.includes("pullRequestReviewers")
                ? { value: pr.reviewers }
                : {
                    comments: [{ id: 1, content: "```suggestion\nnew\n```" }],
                    ...input.thread,
                  },
          ),
        };
      }),
    writeJson: (write) =>
      Effect.sync(() => {
        writes.push(write);
        return JSON.stringify({ commits: [{ commitId: "applied-sha" }] });
      }),
    write: (write) =>
      Effect.sync(() => {
        writes.push(write);
      }),
    failure: (failure) => new AzureDevOpsPullRequestReadError(failure),
  });
  const apply = (expectedHead = "source-sha") =>
    tools.run({
      ...target,
      action: { type: "apply-suggestion", commentId: "8:1", expectedHead },
    });
  return { apply, writes, reads, items };
};
const numbered = (count: number, replace: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, line) => replace[line + 1] ?? `line ${line + 1}`).join("\n") +
  "\n";

it.effect("applies a suggestion at its position tracked to the latest push", () =>
  Effect.gen(function* () {
    // Left on line 10 of the first push; the second inserted three lines above it.
    const fixture = suggestion({
      before: numbered(12, { 10: "old" }),
      after: numbered(15, { 13: "old" }),
      thread: {
        threadContext: {
          filePath: "/sample.ts",
          rightFileStart: { line: 13 },
          rightFileEnd: { line: 13 },
        },
        pullRequestThreadContext: {
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
          trackingCriteria: {
            origRightFileStart: { line: 10 },
            origRightFileEnd: { line: 10 },
          },
        },
      },
    });
    yield* fixture.apply();
    expect(fixture.reads.find((args) => args.includes("pullRequestThreads"))).toEqual(
      expect.arrayContaining(["threadId=8", "$iteration=2", "$baseIteration=0"]),
    );
    expect(fixture.items).toEqual(
      expect.arrayContaining([
        { path: "/sample.ts", commit: "source-sha", project: "source-project" },
        { path: "/sample.ts", commit: "first-sha", project: "source-project" },
      ]),
    );
    expect(fixture.writes[0]?.routeParameters).toEqual([
      "project=source-project",
      "repositoryId=source-repo",
    ]);
    expect(JSON.parse(fixture.writes[0]!.body!)).toMatchObject({
      refUpdates: [{ name: "refs/heads/feature", oldObjectId: "source-sha" }],
      commits: [
        {
          changes: [
            {
              item: { path: "/sample.ts" },
              newContent: { content: numbered(15, { 13: "new" }) },
            },
          ],
        },
      ],
    });
    expect(fixture.writes[1]).toMatchObject({ resource: "pullRequestThreads", method: "PATCH" });
  }),
);

it.effect(
  "refuses a suggestion whose lines changed or moved without tracking, or a stale head",
  () =>
    Effect.gen(function* () {
      const untracked = {
        threadContext: {
          filePath: "/sample.ts",
          rightFileStart: { line: 10 },
          rightFileEnd: { line: 10 },
        },
        pullRequestThreadContext: {
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
        },
      };
      // Azure leaves a deleted anchor untracked at its old position, over unrelated text.
      const deleted = suggestion({
        before: numbered(12, { 10: "old" }),
        after: numbered(11),
        thread: untracked,
      });
      expect((yield* Effect.flip(deleted.apply())).detail).toContain(
        "changed after it was written",
      );
      // A suggestion whose push is not the head being edited cannot place its lines.
      const stale = suggestion({ before: "", after: "", thread: untracked });
      yield* Effect.flip(stale.apply("stale-head"));
      // An untouched anchor needs no tracking and still applies.
      const untouched = suggestion({
        before: numbered(12, { 10: "old" }),
        after: numbered(12, { 10: "old" }),
        thread: untracked,
      });
      yield* untouched.apply();
      expect(deleted.writes).toHaveLength(0);
      expect(stale.writes).toHaveLength(0);
      expect(untouched.writes).toHaveLength(2);
    }),
);

it.effect("addresses caller-supplied route values by their encoded value", () =>
  Effect.gen(function* () {
    const tools = fixture();
    yield* tools.run({
      ...target,
      action: { type: "attachment-delete", fileName: "notes#v2?.png" },
    });
    yield* tools.run({
      ...target,
      action: { type: "requeue-policy", evaluationId: "../../_apis/x?y" },
    });
    yield* tools.run({
      ...target,
      action: { type: "reviewer-required", reviewerId: "a/b#c", required: true },
    });
    expect(tools.writes.map((write) => write.routeParameters.at(-1))).toEqual([
      "fileName=notes%23v2%3F.png",
      "evaluationId=..%2F..%2F_apis%2Fx%3Fy",
      "reviewerId=a%2Fb%23c",
    ]);
  }),
);

it.effect("arms auto-complete and its options in one update", () =>
  Effect.gen(function* () {
    const tools = fixture();
    yield* tools.run({
      ...target,
      action: {
        type: "complete",
        automatic: true,
        strategy: "squash",
        deleteSourceBranch: false,
        transitionWorkItems: true,
        message: "",
        bypassPolicy: false,
        bypassReason: "",
        waitForOptionalPolicies: true,
      },
    });
    expect(tools.writes).toHaveLength(1);
    expect(JSON.parse(tools.writes[0]!.body!)).toMatchObject({
      autoCompleteSetBy: { id: "reader" },
      completionOptions: { mergeStrategy: "squash", autoCompleteIgnoreConfigIds: [] },
    });
    expect(tools.commands.some((args) => args.includes("update"))).toBe(false);
  }),
);

it.effect(
  "discovers users and project groups, preserves existing requests, and reports a partial directory",
  () =>
    Effect.gen(function* () {
      const tools = makeAzureDevOpsPullRequestTools({
        listIterations: () => Effect.die("unused"),
        readItemContent: () => Effect.die("unused"),
        resolveIdentities: () =>
          Effect.succeed({
            stdout: JSON.stringify({ value: [{ id: "team", descriptor: "team-descriptor" }] }),
          }),
        identity: () =>
          Effect.succeed({ id: "reader", login: "reader@example.com", name: "Reader" }),
        subscriptions: () => Effect.die("unused"),
        uploadAttachment: () => Effect.die("unused"),
        write: () => Effect.die("unused"),
        writeJson: () => Effect.die("unused"),
        failure: (input) => new AzureDevOpsPullRequestReadError(input),
        execute: (input) =>
          Effect.succeed({
            stdout: JSON.stringify(
              input.args.includes("show")
                ? { ...pr, createdBy: { id: "author" } }
                : input.args.includes("pullRequestReviewers")
                  ? { value: pr.reviewers }
                  : input.args.includes("user")
                    ? {
                        totalCount: 3,
                        items: [
                          {
                            id: "author",
                            user: { displayName: "Author", mailAddress: "author@example.com" },
                          },
                          {
                            id: "other",
                            user: { displayName: "Other", mailAddress: "other@example.com" },
                          },
                        ],
                      }
                    : {
                        continuationToken: null,
                        graphGroups: [
                          {
                            descriptor: "team-descriptor",
                            displayName: "Review team",
                            principalName: "[project]\\Review team",
                          },
                        ],
                      },
            ),
          }),
      });
      const page = yield* tools.reviewerCandidates(target);
      expect(page.truncated).toBe(true);
      expect(page.candidates.map((person) => [person.id, person.kind, person.isRequested])).toEqual(
        [
          ["other", "user", false],
          ["team", "team", false],
          ["reader", "user", true],
        ],
      );
    }),
);

it.effect("keeps the current reviewers when the directory cannot be read", () =>
  Effect.gen(function* () {
    const tools = makeAzureDevOpsPullRequestTools({
      listIterations: () => Effect.die("unused"),
      readItemContent: () => Effect.die("unused"),
      resolveIdentities: () => Effect.die("unused"),
      identity: () => Effect.die("unused"),
      subscriptions: () => Effect.die("unused"),
      uploadAttachment: () => Effect.die("unused"),
      write: () => Effect.die("unused"),
      writeJson: () => Effect.die("unused"),
      failure: (input) => new AzureDevOpsPullRequestReadError(input),
      execute: (input) =>
        input.args.includes("show") || input.args.includes("pullRequestReviewers")
          ? Effect.succeed({
              stdout: JSON.stringify(
                input.args.includes("show")
                  ? { ...pr, createdBy: { id: "author" } }
                  : { value: pr.reviewers },
              ),
            })
          : Effect.fail(
              new AzureDevOpsPullRequestReadError({
                cwd: "/w",
                command: "az",
                operation: "directory",
                cause: "TF400813: not authorized to access this resource.",
              }),
            ),
    });
    const page = yield* tools.reviewerCandidates(target);
    expect(page.truncated).toBe(true);
    expect(page.candidates.map((person) => [person.id, person.isRequested])).toEqual([
      ["reader", true],
    ]);
  }),
);

it.effect(
  "does not report a created cherry-pick branch as a failed operation when PR creation is refused",
  () =>
    Effect.gen(function* () {
      const tools = fixture();
      const result = yield* tools.run({
        ...target,
        action: {
          type: "cherry-pick",
          targetBranch: "main",
          newBranch: "test/cherry-pick",
          createPullRequest: true,
        },
      });
      expect(result.message).toContain("Branch created, but");
      expect(result.url).toBe(
        "https://dev.azure.com/example/project/_git/sandbox?version=GBtest%2Fcherry-pick",
      );
      expect(tools.writes).toHaveLength(1);
      expect(tools.commands.filter((args) => args.includes("create"))).toHaveLength(1);
    }),
);
it.effect(
  "refuses failed branch operations and reverting an unmerged PR before creating a follow-up",
  () =>
    Effect.gen(function* () {
      const failed = fixture({}, { cherryPickId: 1, status: "failed" });
      yield* failed
        .run({
          ...target,
          action: {
            type: "cherry-pick",
            targetBranch: "main",
            newBranch: "test/failure",
            createPullRequest: true,
          },
        })
        .pipe(Effect.flip);
      expect(failed.commands.some((args) => args.includes("create"))).toBe(false);
      const active = fixture();
      yield* active
        .run({
          ...target,
          action: { type: "revert", targetBranch: "main", newBranch: "test/revert" },
        })
        .pipe(Effect.flip);
      expect(active.writes).toHaveLength(0);
    }),
);

it.effect("honors allowed merge types and legacy squash policy settings", () =>
  Effect.gen(function* () {
    for (const [settings, expected] of [
      [
        {
          allowSquash: true,
          allowRebase: true,
          allowNoFastForward: false,
          allowRebaseMerge: false,
        },
        ["squash", "rebase"],
      ],
      [{ useSquashMerge: true }, ["squash"]],
      [{ useSquashMerge: false }, ["noFastForward"]],
      [{ useSquashMerge: false, allowSquash: true, allowNoFastForward: false }, ["squash"]],
    ] as const) {
      const result = yield* fixture({}, undefined, settings).details(target);
      expect(result.allowedMergeStrategies).toEqual(expected);
    }
  }),
);
