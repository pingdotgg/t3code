import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";

const mockedIdentity = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["authenticatedIdentity"]>();

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: mockedExecute,
        pullRequestContext: () =>
          Effect.succeed(output(JSON.stringify({ credentialKey: "test-pat", permissions: {} }))),
        authenticatedIdentity: mockedIdentity,
      }),
    ),
    Layer.provideMerge(NodeFileSystem.layer),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

const VCS_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function outputWithin(maxOutputBytes: number | undefined, response: string) {
  const ceiling = maxOutputBytes ?? VCS_DEFAULT_MAX_OUTPUT_BYTES;
  return ceiling >= Buffer.byteLength(response)
    ? output(response)
    : { ...output(response.slice(0, ceiling)), stdoutTruncated: true };
}

const json = (value: Record<string, unknown>) => JSON.stringify(value);

const pullRequestRow = {
  pullRequestId: 42,
  title: "Add the page",
  status: "active",
  sourceRefName: "refs/heads/feat/page",
  targetRefName: "refs/heads/main",
  creationDate: "2026-07-01T00:00:00Z",
  url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
  repository: { name: "web", project: { name: "platform" } },
};

const oneIteration = {
  value: [
    {
      id: 1,
      sourceRefCommit: { commitId: "a".repeat(40) },
      commonRefCommit: { commitId: "b".repeat(40) },
    },
  ],
};

function pullRequestRows(
  count: number,
  firstNumber: number,
): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    pullRequestId: firstNumber + index,
    title: `Pull request ${firstNumber + index}`,
    status: "active",
    sourceRefName: "refs/heads/feat/page",
    targetRefName: "refs/heads/main",
    creationDate: "2026-07-01T00:00:00Z",
    repository: { name: "web", project: { name: "platform" } },
    url: `https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/${firstNumber + index}`,
  }));
}

function pullRequests(count: number, firstNumber: number): string {
  return JSON.stringify(pullRequestRows(count, firstNumber));
}

function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}

function maxOutputBytesOfCall(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].maxOutputBytes;
}

function changeEntries(count: number): ReadonlyArray<Record<string, unknown>> {
  const commit = "c".repeat(40);
  return Array.from({ length: count }, (_, index) => {
    const path = `/apps/server/src/generated/module-${index}/persisted-projection-${index}.ts`;
    return {
      changeType: "edit",
      item: {
        path,
        objectId: "a".repeat(40),
        originalObjectId: "b".repeat(40),
        commitId: commit,
        gitObjectType: "blob",
        url: `https://dev.azure.com/acme/platform/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/items${path}?versionType=Commit&version=${commit}`,
      },
    };
  });
}

function identity(name: string) {
  const id = "6f9c9b7f-0000-0000-0000-000000000000";
  return {
    displayName: name,
    id,
    uniqueName: `${name.toLowerCase().replace(/ /g, ".")}@acme.com`,
    descriptor: `aad.${"z".repeat(52)}`,
    imageUrl: `https://dev.azure.com/acme/_api/_common/identityImage?id=${id}`,
    url: `https://spsprodweu1.vssps.visualstudio.com/A${id}/_apis/Identities/${id}`,
    _links: {
      avatar: {
        href: `https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/aad.${"z".repeat(52)}`,
      },
    },
  };
}

function threadRows(count: number): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    publishedDate: "2026-07-02T00:00:00Z",
    lastUpdatedDate: "2026-07-02T00:00:00Z",
    status: "active",
    threadContext: { filePath: `/apps/server/src/generated/module-${index}.ts` },
    identities: { 1: identity("Reviewer One") },
    isDeleted: false,
    comments: [
      {
        id: 1,
        parentCommentId: 0,
        author: identity("Reviewer One"),
        content: `Comment ${index}: ${"this needs another look. ".repeat(20)}`,
        publishedDate: "2026-07-02T00:00:00Z",
        lastUpdatedDate: "2026-07-02T00:00:00Z",
        commentType: "text",
        usersLiked: [],
      },
    ],
  }));
}

function iterationRows(count: number): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    description: `Pushed ${index} commits`,
    author: identity("Author One"),
    createdDate: "2026-07-02T00:00:00Z",
    updatedDate: "2026-07-02T00:00:00Z",
    sourceRefCommit: { commitId: `${index}`.padStart(40, "a") },
    targetRefCommit: { commitId: "b".repeat(40) },
    commonRefCommit: { commitId: "c".repeat(40) },
    hasMultipleCommits: true,
    reason: "push",
    push: { pushId: index + 1, date: "2026-07-02T00:00:00Z", pushedBy: identity("Author One") },
  }));
}

afterEach(() => {
  mockedExecute.mockReset();
});

layer("AzureDevOpsPullRequestCli.layer", (it) => {
  it.effect("retains Azure line ranges, deleted-side anchors, and whole-file discussions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodies: unknown[] = [];
      mockedExecute.mockImplementation((input) =>
        Effect.gen(function* () {
          if (input.args.includes("pullRequestIterations"))
            return output(JSON.stringify(oneIteration));
          if (input.args.includes("pullRequestIterationChanges"))
            return output(
              JSON.stringify({
                changeEntries: ["file.ts", "old.ts"].map((path) => ({
                  changeTrackingId: 12,
                  changeType: "edit",
                  item: { path: "/" + path },
                })),
              }),
            );
          bodies.push(
            JSON.parse(
              yield* fs
                .readFileString(input.args[input.args.indexOf("--in-file") + 1]!)
                .pipe(Effect.orDie),
            ),
          );
          return output("{}");
        }),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      yield* cli.createThreads({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        threads: [
          {
            path: "file.ts",
            position: { kind: "added" as const, newLine: 7 },
            startLine: 3,
            body: "Test",
          },
          {
            path: "old.ts",
            position: { kind: "deleted" as const, oldLine: 9 },
            startLine: 5,
            body: "Test",
          },
          {
            path: "file.ts",
            position: { kind: "added" as const, newLine: 1 },
            fileLevel: true,
            body: "Test",
          },
        ].map((comment) => ({ body: comment.body, comment })),
      });
      // One review resolves its anchors once, however many comments it carries.
      for (const resource of ["pullRequestIterations", "pullRequestIterationChanges"])
        expect(
          mockedExecute.mock.calls.filter(([input]) => input.args.includes(resource)),
        ).toHaveLength(1);
      expect(bodies).toEqual([
        expect.objectContaining({
          pullRequestThreadContext: {
            changeTrackingId: 12,
            iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
          },
          threadContext: {
            filePath: "/file.ts",
            rightFileStart: { line: 3, offset: 1 },
            rightFileEnd: { line: 7, offset: 1 },
          },
        }),
        expect.objectContaining({
          threadContext: {
            filePath: "/old.ts",
            leftFileStart: { line: 5, offset: 1 },
            leftFileEnd: { line: 9, offset: 1 },
          },
        }),
        expect.objectContaining({ threadContext: { filePath: "/file.ts" } }),
      ]);
    }),
  );

  it.effect("uses the preview policy API when requeueing an evaluation", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          output(
            JSON.stringify(
              input.args.includes("show")
                ? {
                    pullRequestId: 42,
                    status: "active",
                    repository: {
                      id: "repo",
                      webUrl: "https://dev.azure.com/a/p/_git/web",
                      project: { id: "project" },
                    },
                    reviewers: [],
                  }
                : { value: [] },
            ),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      yield* cli.runHostAction({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        action: { type: "requeue-policy", evaluationId: "evaluation" },
      });
      expect(
        mockedExecute.mock.calls.find(([input]) => input.args.includes("PATCH"))?.[0].args,
      ).toEqual(
        expect.arrayContaining(["--api-version", "7.1-preview", "evaluationId=evaluation"]),
      );
    }),
  );

  it.effect("posts a UTF-8 reply to the existing thread and removes its temporary body", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let bodyFile = "";
      const body = 'Réponse avec **markdown**\nQuotes: "hello" and `code`.';
      mockedExecute.mockImplementationOnce((input) =>
        Effect.gen(function* () {
          bodyFile = input.args[input.args.indexOf("--in-file") + 1]!;
          expect(JSON.parse(yield* fs.readFileString(bodyFile).pipe(Effect.orDie))).toEqual({
            content: body,
            parentCommentId: 1,
            commentType: 1,
          });
          return output("{}");
        }),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      yield* cli.replyToThread({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        threadId: "7734",
        body,
      });
      expect(argsOfCall(0)).toEqual([
        "devops",
        "invoke",
        "--detect",
        "true",
        "--area",
        "git",
        "--resource",
        "pullRequestThreadComments",
        "--api-version",
        "7.1",
        "--route-parameters",
        "project=platform",
        "repositoryId=web",
        "pullRequestId=42",
        "threadId=7734",
        "--http-method",
        "POST",
        "--in-file",
        bodyFile,
        "--encoding",
        "utf-8",
        "--only-show-errors",
        "--output",
        "json",
      ]);
      expect(yield* fs.exists(bodyFile)).toBe(false);
    }),
  );

  it.effect("edits, deletes, and changes Azure discussion status using native routes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodies: unknown[] = [];
      mockedExecute.mockImplementation((input) =>
        Effect.gen(function* () {
          const index = input.args.indexOf("--in-file");
          if (index >= 0)
            bodies.push(
              JSON.parse(yield* fs.readFileString(input.args[index + 1]!).pipe(Effect.orDie)),
            );
          return output(input.args.includes("DELETE") ? "" : "{}");
        }),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const ref = {
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        threadId: "7734",
      };
      yield* cli.updateComment({
        ...ref,
        commentId: "3",
        body: "This is a test for the app t3code — edited.",
      });
      yield* cli.deleteComment({ ...ref, commentId: "3" });
      for (const status of [
        "active",
        "pending",
        "fixed",
        "wontFix",
        "closed",
        "byDesign",
      ] as const) {
        yield* cli.setThreadStatus({ ...ref, status });
      }
      expect(bodies).toEqual([
        { content: "This is a test for the app t3code — edited." },
        ...["active", "pending", "fixed", "wontFix", "closed", "byDesign"].map((status) => ({
          status,
        })),
      ]);
      expect(argsOfCall(0)).toEqual(
        expect.arrayContaining([
          "PATCH",
          "pullRequestThreadComments",
          "threadId=7734",
          "commentId=3",
        ]),
      );
      expect(argsOfCall(1)).toEqual(
        expect.arrayContaining(["DELETE", "pullRequestThreadComments", "commentId=3"]),
      );
      expect(argsOfCall(2)).toEqual(
        expect.arrayContaining(["PATCH", "pullRequestThreads", "threadId=7734"]),
      );
    }),
  );

  it.effect("keeps a refused reply as a failure and cleans up its temporary body", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let bodyFile = "";
      const failure = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 0,
        cause: "refused",
      });
      mockedExecute.mockImplementationOnce((input) => {
        bodyFile = input.args[input.args.indexOf("--in-file") + 1]!;
        return Effect.fail(failure);
      });
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      expect(
        yield* Effect.flip(
          cli.replyToThread({
            cwd: "/w",
            location: { project: "platform", repository: "web" },
            number: 42,
            threadId: "7734",
            body: "Reply",
          }),
        ),
      ).toBe(failure);
      expect(yield* fs.exists(bodyFile)).toBe(false);
    }),
  );

  it.effect("asks for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "list",
        "--detect",
        "true",
        "--repository",
        "web",
        "--status",
        "active",
        "--include-links",
        "--top",
        "11",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("reads an Azure pull request page larger than the VCS default output limit", () =>
    Effect.gen(function* () {
      const rows = pullRequestRows(100, 1).map((row) => ({
        ...row,
        description: "x".repeat(10_000),
      }));
      const response = JSON.stringify(rows);
      expect(Buffer.byteLength(response)).toBeGreaterThan(1_000_000);

      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "merged",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 99,
      });

      assert.strictEqual(batch.items.length, 99);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("reads the page unnarrowed when asked to search, having nothing to search with", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const page = yield* provider.listChangeRequests({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
        query: "page",
      });

      assert.strictEqual(page.items.length, 3);
      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "list",
        "--detect",
        "true",
        "--repository",
        "web",
        "--status",
        "active",
        "--include-links",
        "--top",
        "11",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("steps over what it has already handed over, which is all Azure can be told", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(3, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 20 },
      });

      const args = argsOfCall(0);
      expect(args).toContain("--skip");
      assert.strictEqual(args[args.indexOf("--skip") + 1], "20");
      expect(args).not.toContain("2026-07-02T00:00:00Z");
    }),
  );

  it.effect("reports truncation from the extra row", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 10);
    }),
  );

  it.effect("advances by malformed raw rows and keeps reading until the page is full", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                { pullRequestId: "malformed" },
                pullRequestRows(1, 1)[0],
                { pullRequestId: "also malformed" },
              ]),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(pullRequests(2, 2))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.isTrue(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 4);
      const secondArgs = argsOfCall(1);
      assert.strictEqual(secondArgs[secondArgs.indexOf("--skip") + 1], "3");
      assert.strictEqual(secondArgs[secondArgs.indexOf("--top") + 1], "2");
    }),
  );

  it.effect("narrows to the author on the authored tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "closed",
        involvement: "authored",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      expect(argsOfCall(0)).toContain("--creator");
      expect(argsOfCall(0)).toContain("bilal@acme.dev");
      expect(argsOfCall(0)).toContain("abandoned");
    }),
  );

  it.effect("asks Azure for every status on the All tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "all",
        involvement: "all",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      expect(argsOfCall(0)).toContain("--status");
      expect(argsOfCall(0)).toContain("all");
    }),
  );

  it.effect("narrows to the reviewer on the reviewing tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal@acme.dev",
        limit: 10,
      });

      expect(argsOfCall(0)).toContain("--reviewer");
    }),
  );

  it.effect(
    "uses the authenticated DevOps identity even when the user has never authored a PR",
    () =>
      Effect.gen(function* () {
        mockedIdentity.mockReturnValueOnce(
          Effect.succeed({ id: "viewer-id", login: "bilal@acme.dev", name: "Bilal" }),
        );
        const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
        expect(yield* cli.getViewer({ cwd: "/w" })).toBe("bilal@acme.dev");
        expect(mockedExecute).not.toHaveBeenCalled();
      }),
  );
  it.effect("does not substitute a cloud identity when DevOps authentication fails", () =>
    Effect.gen(function* () {
      const signedOut = new AzureDevOpsCli.AzureDevOpsCliAuthenticationError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 2,
        cause: "signed out",
      });
      mockedIdentity.mockReturnValueOnce(Effect.fail(signedOut));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      expect((yield* Effect.flip(cli.getViewer({ cwd: "/w" })))._tag).toBe(
        "AzureDevOpsCliAuthenticationError",
      );
      expect(mockedExecute).not.toHaveBeenCalled();
    }),
  );

  it.effect("completes a pull request to merge it, squashing only when asked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        number: 42,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "42",
        "--status",
        "completed",
        "--squash",
        "true",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("stores the squash choice with an auto-completion, as a merge now does", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        number: 42,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "42",
        "--auto-complete",
        "true",
        "--squash",
        "true",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect.each([
    { action: "enable-auto-merge", expected: ["--auto-complete", "true"] },
    { action: "disable-auto-merge", expected: ["--auto-complete", "false"] },
    { action: "draft", expected: ["--draft", "true"] },
    { action: "ready", expected: ["--draft", "false"] },
    { action: "close", expected: ["--status", "abandoned"] },
    { action: "reopen", expected: ["--status", "active"] },
  ] as const)("moves a pull request with $action", ({ action, expected }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.runPullRequestAction({ cwd: "/w", number: 42, action });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "42",
        ...expected,
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect.each([
    { name: "a title", rewrite: { title: "Add the page" }, expected: ["--title=Add the page"] },
    {
      name: "a description",
      rewrite: { body: "Why the page changed" },
      expected: ["--description=Why the page changed"],
    },
    {
      name: "both",
      rewrite: { title: "Add the page", body: "Why the page changed" },
      expected: ["--title=Add the page", "--description=Why the page changed"],
    },
  ] as const)("rewrites $name, sending nothing it was not given", ({ rewrite, expected }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.updatePullRequest({ cwd: "/w", number: 42, ...rewrite });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "update",
        "--detect",
        "true",
        "--id",
        "42",
        ...expected,
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("sends a description that starts with a dash as one value, not as a flag", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.updatePullRequest({
        cwd: "/w",
        number: 42,
        body: "- rewrote the page\n- kept the rest",
      });

      expect(argsOfCall(0)).toContain("--description=- rewrote the page\n- kept the rest");
    }),
  );

  it.effect("rewrites through the provider, which says it takes one", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(output(JSON.stringify(input.args.includes("show") ? pullRequestRow : {}))),
      );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      expect(provider.capabilities.edit).toEqual({
        changeRequest: true,
        comment: true,
        deleteComment: true,
      });
      assert.isDefined(provider.updateChangeRequest);
      yield* provider.updateChangeRequest({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        title: "Add the page",
      });

      expect(
        argsOfCall(mockedExecute.mock.calls.findIndex(([input]) => input.args.includes("update"))),
      ).toContain("--title=Add the page");
      expect(
        argsOfCall(mockedExecute.mock.calls.findIndex(([input]) => input.args.includes("update"))),
      ).not.toContain("--description");
    }),
  );

  it.effect("names the head's blob as what a cleared file was cleared at", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                  {
                    id: 2,
                    sourceRefCommit: { commitId: "c".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                changeEntries: [
                  { changeType: "edit", item: { path: "/README.md", objectId: "8f80" } },
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      // Kept here rather than on Azure: its own record of what a reader has read is behind an
      // undocumented endpoint, so the marks belong to this environment and need a revision of
      // their own to tell a re-push from a file still as it was read.
      assert.strictEqual(provider.capabilities.viewedFiles, "host");
      assert.isDefined(provider.getFileRevisions);
      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["README.md"],
      });

      expect(argsOfCall(2)).toContain("iterationId=2");
      expect([...answer.revisions]).toEqual([["README.md", "8f80"]]);
    }),
  );

  it.effect("reads where a pull request lives once, however often it is asked about", () =>
    Effect.gen(function* () {
      const pullRequest = Effect.succeed(
        output(
          JSON.stringify({
            pullRequestId: 42,
            title: "Add the page",
            status: "active",
            sourceRefName: "refs/heads/feat/page",
            targetRefName: "refs/heads/main",
            creationDate: "2026-07-01T00:00:00Z",
            url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
            repository: { name: "web", project: { name: "platform" } },
          }),
        ),
      );
      const iterations = () =>
        Effect.succeed(
          output(
            JSON.stringify({
              value: [
                {
                  id: 1,
                  sourceRefCommit: { commitId: "a".repeat(40) },
                  commonRefCommit: { commitId: "b".repeat(40) },
                },
              ],
            }),
          ),
        );
      const changes = () =>
        Effect.succeed(
          output(
            JSON.stringify({
              changeEntries: [
                { changeType: "edit", item: { path: "/README.md", objectId: "8f80" } },
              ],
            }),
          ),
        );
      mockedExecute
        .mockReturnValueOnce(pullRequest)
        .mockReturnValueOnce(iterations())
        .mockReturnValueOnce(changes())
        .mockReturnValueOnce(iterations())
        .mockReturnValueOnce(changes());
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      const read = provider.getFileRevisions;
      assert.isDefined(read);
      const ask = () =>
        read({
          cwd: "/w",
          repository: "web",
          host: "dev.azure.com",
          number: 42,
          paths: ["README.md"],
        });

      yield* ask();
      const again = yield* ask();

      assert.strictEqual(mockedExecute.mock.calls.length, 5);
      expect(argsOfCall(3)).toContain("pullRequestIterations");
      expect([...again.revisions]).toEqual([["README.md", "8f80"]]);
    }),
  );

  it.effect(
    "answers for a marked file the pull request no longer changes as the empty version",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(
              output(
                json({
                  pullRequestId: 42,
                  title: "Add the page",
                  status: "active",
                  sourceRefName: "refs/heads/feat/page",
                  targetRefName: "refs/heads/main",
                  creationDate: "2026-07-01T00:00:00Z",
                  url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                  repository: { name: "web", project: { name: "platform" } },
                }),
              ),
            ),
          )
          .mockReturnValueOnce(
            Effect.succeed(
              output(
                json({
                  value: [
                    {
                      id: 1,
                      sourceRefCommit: { commitId: "a".repeat(40) },
                      commonRefCommit: { commitId: "b".repeat(40) },
                    },
                  ],
                }),
              ),
            ),
          )
          .mockReturnValueOnce(Effect.succeed(output('{"changeEntries":[]}')));
        const provider = yield* AzureDevOpsPullRequestProvider.make;
        assert.isDefined(provider.getFileRevisions);

        const answer = yield* provider.getFileRevisions({
          cwd: "/w",
          repository: "web",
          host: "dev.azure.com",
          number: 42,
          paths: ["GONE.md"],
        });

        expect([...answer.revisions]).toEqual([["GONE.md", ""]]);
      }),
  );

  it.effect("says nothing about the files past the end of a change it gave up following", () =>
    Effect.gen(function* () {
      const entries = (from: number, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          changeType: "edit",
          item: { path: `/src/f${from + index}.ts`, objectId: `blob-${from + index}` },
        }));
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(json({ changeEntries: entries(0, 5_000), nextSkip: 5_000 }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(json({ changeEntries: entries(5_000, 5_000), nextSkip: 10_000 }))),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["src/f1.ts", "src/f5001.ts", "src/past-the-cut.ts"],
      });

      expect(argsOfCall(3)).toContain("$skip=5000");
      expect([...answer.revisions]).toEqual([
        ["src/f1.ts", "blob-1"],
        ["src/f5001.ts", "blob-5001"],
      ]);
    }),
  );

  it.effect("stops following pages by what Azure counts, not by what survives decoding", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockImplementation((command) => {
          const skip = command.args.find((arg) => arg.startsWith("$skip="));
          const from = Number(skip?.slice("$skip=".length) ?? 0);
          return Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "add", item: { path: "/src", isFolder: true } }],
                nextSkip: from + 2_000,
              }),
            ),
          );
        });
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["src/page.ts"],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 7);
      assert.strictEqual(answer.revisions.size, 0);
    }),
  );

  it.effect("leaves one file the host would not hand over listed without its hunks", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(json(pullRequestRow))))
        .mockReturnValueOnce(Effect.succeed(output(json(oneIteration))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/huge.bin", objectId: "8f80" } },
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new AzureDevOpsCli.AzureDevOpsCommandFailedError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: 1,
              cause: "the blob is past what the route will carry",
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(json({ content: "hello\n" }))));
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const slice = yield* provider.getDiff({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
      });

      assert.isTrue(slice.truncated);
      expect(slice.patch).toContain("diff --git a/huge.bin b/huge.bin");
      expect(slice.patch).toContain("+hello");
    }),
  );

  it.effect("fails the whole read when it is the connection that would not answer", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(json(pullRequestRow))))
        .mockReturnValueOnce(Effect.succeed(output(json(oneIteration))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/DEMO.md", objectId: "0ca4" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.fail(
            new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
              operation: "execute",
              command: "az",
              cwd: "/w",
              argumentCount: 1,
              cause: "429",
            }),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const error = yield* Effect.flip(
        provider.getDiff({ cwd: "/w", repository: "web", host: "dev.azure.com", number: 42 }),
      );

      assert.strictEqual(error.reason, "rate-limited");
    }),
  );

  it.effect("takes Azure's own word on a file it will not spell out", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [
                  { changeType: "add", item: { path: "/logo.png", objectId: "8f80" } },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(json({ content: "iVBORw0KGgo=", contentMetadata: { isBinary: true } })),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      const slice = yield* provider.getDiff({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
      });

      expect(argsOfCall(3)).toContain("includeContentMetadata=true");
      expect(slice.patch).toContain("Binary files a/logo.png and b/logo.png differ");
      assert.isTrue(slice.truncated);
    }),
  );

  it.effect("stops following pages when one of them does not move the cursor on", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                pullRequestId: 42,
                title: "Add the page",
                status: "active",
                sourceRefName: "refs/heads/feat/page",
                targetRefName: "refs/heads/main",
                creationDate: "2026-07-01T00:00:00Z",
                url: "https://dev.azure.com/acme/_apis/git/repositories/web/pullRequests/42",
                repository: { name: "web", project: { name: "platform" } },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                value: [
                  {
                    id: 1,
                    sourceRefCommit: { commitId: "a".repeat(40) },
                    commonRefCommit: { commitId: "b".repeat(40) },
                  },
                ],
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "edit", item: { path: "/a.ts", objectId: "8f80" } }],
                nextSkip: 2_000,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              json({
                changeEntries: [{ changeType: "edit", item: { path: "/b.ts", objectId: "0ca4" } }],
                nextSkip: 2_000,
              }),
            ),
          ),
        );
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["a.ts", "b.ts", "unlisted.ts"],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      expect([...answer.revisions]).toEqual([
        ["a.ts", "8f80"],
        ["b.ts", "0ca4"],
      ]);
    }),
  );

  it.effect("asks Azure nothing when no file has been ticked off", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output('{"changeEntries":[]}')));
      const provider = yield* AzureDevOpsPullRequestProvider.make;
      assert.isDefined(provider.getFileRevisions);

      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: [],
      });

      expect(answer.revisions.size).toBe(0);
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads the conversation through the REST API, pinned to a version", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              value: [
                {
                  id: 1,
                  comments: [
                    { id: 1, content: "Looks good.", publishedDate: "2026-07-02T00:00:00Z" },
                  ],
                },
              ],
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const comments = yield* cli.listThreads({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
      });

      assert.strictEqual(comments.length, 1);
      expect(argsOfCall(0)).toContain("invoke");
      expect(argsOfCall(0)).toContain("pullRequestThreads");
      expect(argsOfCall(0)).toContain("project=platform");
      expect(argsOfCall(0)).toContain("repositoryId=web");
      expect(argsOfCall(0)).toContain("pullRequestId=42");
      expect(maxOutputBytesOfCall(0)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
    }),
  );

  it.effect("reads a long review's threads, which are past the default output limit", () =>
    Effect.gen(function* () {
      const response = json({ value: threadRows(800) });
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const comments = yield* cli.listThreads({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
      });

      assert.strictEqual(comments.length, 800);
    }),
  );

  it.effect("reads a long review's iterations, which are past the default output limit", () =>
    Effect.gen(function* () {
      const response = json({ value: iterationRows(1_200) });
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const iterations = yield* cli.listIterations({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
      });

      assert.strictEqual(iterations.length, 1_200);
      assert.strictEqual(iterations.at(-1)?.id, 1_200);
    }),
  );

  it.effect("reads a full page of change entries, which is past the default output limit", () =>
    Effect.gen(function* () {
      const response = json({ changeEntries: changeEntries(2_000) });
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const page = yield* cli.listIterationChanges({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        iterationId: 1,
      });

      assert.strictEqual(page.changes.length, 2_000);
      assert.isFalse(page.truncated);
    }),
  );

  it.effect("reads a file whose JSON envelope is past the default output limit", () =>
    Effect.gen(function* () {
      const file = "const value = 1;\n".repeat(57_000);
      const response = json({ content: file });
      expect(Buffer.byteLength(file)).toBeLessThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      expect(Buffer.byteLength(response)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.succeed(outputWithin(input.maxOutputBytes, response)),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const item = yield* cli.readItemContent({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        path: "src/generated/schema.ts",
        commit: "a".repeat(40),
      });

      assert.strictEqual(item.contents, file);
      assert.isFalse(item.isBinary);
    }),
  );

  it.effect("asks for a file by Azure's own spelling of its path", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(json({ content: "const a = 1;" }))));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.readItemContent({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        path: "src/app.ts",
        commit: "a".repeat(40),
      });

      expect(argsOfCall(0)).toContain("path=/src/app.ts");
    }),
  );

  it.effect("reports a pull request it cannot place as its own outcome", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add the page",
              sourceRefName: "refs/heads/feat/page",
              targetRefName: "refs/heads/main",
              creationDate: "2026-07-01T00:00:00Z",
            }),
          ),
        ),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/w", number: 42 }));

      assert.strictEqual(error._tag, "AzureDevOpsPullRequestIncompleteError");
    }),
  );

  it.effect("fails the read when az returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"not found"}')));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getPullRequest({ cwd: "/w", number: 42 }));

      assert.strictEqual(error._tag, "AzureDevOpsPullRequestReadError");
    }),
  );

  it.effect("adds reviewers with the one command Azure has for it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.setPullRequestReviewers({
        cwd: "/w",
        number: 42,
        reviewers: ["octocat@acme.test", "hubot@acme.test"],
        requested: true,
      });

      expect(argsOfCall(0)).toEqual([
        "repos",
        "pr",
        "reviewer",
        "add",
        "--detect",
        "true",
        "--id",
        "42",
        "--reviewers",
        "octocat@acme.test",
        "hubot@acme.test",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("takes a reviewer off the pull request with the same command's counterpart", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      yield* cli.setPullRequestReviewers({
        cwd: "/w",
        number: 42,
        reviewers: ["octocat@acme.test"],
        requested: false,
      });

      expect(argsOfCall(0)).toContain("remove");
    }),
  );

  it.effect("refuses a reviewer az would read as a flag, before running anything", () =>
    Effect.gen(function* () {
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(
        cli.setPullRequestReviewers({
          cwd: "/w",
          number: 42,
          reviewers: ["--query"],
          requested: true,
        }),
      );

      assert.strictEqual(error._tag, "AzureDevOpsReviewerNameError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );
});

layer("Azure comment likes", (it) => {
  it.effect("adds and removes a like using the comment likes route", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const ref = {
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        number: 42,
        threadId: "7734",
        commentId: "2",
      };
      yield* cli.setCommentLike({ ...ref, liked: true });
      yield* cli.setCommentLike({ ...ref, liked: false });
      expect(argsOfCall(0)).toEqual(
        expect.arrayContaining(["pullRequestCommentLikes", "threadId=7734", "commentId=2", "POST"]),
      );
      expect(argsOfCall(1)).toEqual(
        expect.arrayContaining([
          "pullRequestCommentLikes",
          "threadId=7734",
          "commentId=2",
          "DELETE",
        ]),
      );
    }),
  );
});

it("keeps raw read failures out of display text and preserves bounded refusal messages", () => {
  const cause = "remote response containing private details";
  const fields = { command: "az" as const, cwd: "/w", operation: "read", cause };
  const unreadable = new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError(fields);
  expect(unreadable.detail).toBe("Azure CLI returned an unreadable read response.");
  expect(unreadable.message).not.toContain(cause);
  expect(unreadable.cause).toBe(cause);
  const refused = new AzureDevOpsPullRequestCli.AzureDevOpsPullRequestReadError({
    ...fields,
    reason: "stale-suggestion",
  });
  expect(refused.detail).toBe(
    "The source branch changed. Refresh the pull request before applying this suggestion.",
  );
  expect(refused.cause).toBe(cause);
});
