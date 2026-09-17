import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

const layer = it.layer(
  AzureDevOpsPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: mockedExecute,
      }),
    ),
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

/** What VcsProcess allows a read that asked for no ceiling of its own. */
const VCS_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * The runner as it really behaves: it cuts stdout at the ceiling its caller asked for, and cuts
 * it at the process default when the caller asked for none. A read whose response is larger than
 * its ceiling gets JSON that stops mid-string, which is the whole cost of an unset ceiling.
 */
function outputWithin(maxOutputBytes: number | undefined, response: string) {
  const ceiling = maxOutputBytes ?? VCS_DEFAULT_MAX_OUTPUT_BYTES;
  return ceiling >= Buffer.byteLength(response)
    ? output(response)
    : { ...output(response.slice(0, ceiling)), stdoutTruncated: true };
}

/** A fixture's own shape, spelled the way `az` would answer with it. */
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

/** The arguments of the nth az invocation. */
function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}

/** The output ceiling the nth az invocation asked for, if it asked for one at all. */
function maxOutputBytesOfCall(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].maxOutputBytes;
}

/** A page of change entries the size Azure really answers with, url and object ids and all. */
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

/** An Azure identity, which rides along with every comment and every push Azure answers with. */
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

/** A review's threads the shape Azure answers with, system threads and identities and all. */
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

/** A review's iterations the shape Azure answers with, one per push. */
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
      // @effect-diagnostics-next-line preferSchemaOverJson:off
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

      // `az repos pr list` filters by status, creator, reviewer and branch, and by no text at
      // all. The rows come back as they would have without a search, for the caller to narrow;
      // nothing of the search reaches the command, where it could only mean the wrong thing.
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
        // The instant is the same cursor every other host reads; Azure has no filter for it and
        // takes the count instead.
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
              // @effect-diagnostics-next-line preferSchemaOverJson:off
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
      // Three raw rows from the first request and one from the second produced this page.
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
      // Azure calls a closed pull request abandoned.
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

  it.effect("reads the signed-in account, which az reports as a bare value", () =>
    Effect.gen(function* () {
      // `--query user` unwraps the object, so the wrapper has to put it back.
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify({ name: "bilal@acme.dev", type: "user" }))),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const viewer = yield* cli.getViewer({ cwd: "/w" });

      assert.strictEqual(viewer, "bilal@acme.dev");
      expect(argsOfCall(0)).toEqual([
        "account",
        "show",
        "--query",
        "user",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("fails when nobody is signed in", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const error = yield* Effect.flip(cli.getViewer({ cwd: "/w" }));

      assert.strictEqual(error._tag, "AzureDevOpsViewerUnavailableError");
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

      // One argument, so the leading dash of an ordinary bullet list never reaches az as a flag,
      // and the whole text stays together where `--description` would otherwise take several.
      expect(argsOfCall(0)).toContain("--description=- rewrote the page\n- kept the rest");
    }),
  );

  it.effect("rewrites through the provider, which says it takes one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const provider = yield* AzureDevOpsPullRequestProvider.make;

      // False for a remark because nothing here can post one, so there is none to rewrite.
      expect(provider.capabilities.edit).toEqual({ changeRequest: true, comment: false });
      assert.isDefined(provider.updateChangeRequest);
      yield* provider.updateChangeRequest({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        title: "Add the page",
      });

      expect(argsOfCall(0)).toContain("--title=Add the page");
      expect(argsOfCall(0)).not.toContain("--description");
    }),
  );

  it.effect("names the head's blob as what a cleared file was cleared at", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
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
              // @effect-diagnostics-next-line preferSchemaOverJson:off
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
              // @effect-diagnostics-next-line preferSchemaOverJson:off
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
      assert.strictEqual(provider.capabilities.viewedFiles, "environment");
      assert.isDefined(provider.getFileRevisions);
      const answer = yield* provider.getFileRevisions({
        cwd: "/w",
        repository: "web",
        host: "dev.azure.com",
        number: 42,
        paths: ["README.md"],
      });

      // The latest push, since an iteration's changes are reported against the merge base rather
      // than against the push before it.
      expect(argsOfCall(2)).toContain("iterationId=2");
      // Only what was asked for. DEMO.md changed too, and nobody has marked it.
      expect([...answer.revisions]).toEqual([["README.md", "8f80"]]);
    }),
  );

  it.effect("reads where a pull request lives once, however often it is asked about", () =>
    Effect.gen(function* () {
      // A pull request cannot move repositories, and the marks would otherwise pay for a whole
      // pull request read every time they checked whether a file had been pushed to.
      const pullRequest = Effect.succeed(
        output(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
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
      // The second read goes straight to the pushes, and still answers with the head's blob.
      expect(argsOfCall(3)).toContain("pullRequestIterations");
      expect([...again.revisions]).toEqual([["README.md", "8f80"]]);
    }),
  );

  it.effect(
    "answers for a marked file the pull request no longer changes as the empty version",
    () =>
      Effect.gen(function* () {
        // Which is what was stored for it when it was ticked with nothing on the head, so a file
        // the pull request deletes is cleared once and stays cleared.
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
      // Every page is an `az` process of its own, so a change past the ceiling stops being
      // followed. A path nobody looked at must not be answered for as deleted.
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

      // The second page picks up where the first said it ended.
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
        // Nothing a review can show, so every page decodes to nothing at all and a ceiling counted
        // in files would never be reached however long the walk went on.
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

      // The pull request, its pushes, and five pages: the walk gives up on Azure's own offset
      // rather than spending an `az` process a page for as long as Azure keeps paging.
      assert.strictEqual(mockedExecute.mock.calls.length, 7);
      // And it read part of a change, so it says nothing about the file it never saw.
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
      // And the file behind it still renders, which is the point of giving up on one file.
      expect(slice.patch).toContain("+hello");
    }),
  );

  it.effect("fails the whole read when it is the connection that would not answer", () =>
    Effect.gen(function* () {
      // A rate limit is not this file's problem, and answering with a change full of files listed
      // without their hunks would read as a change nobody can see rather than as a host to wait
      // for.
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

      // Azure leaves the metadata out unless it is asked for, and without it every file reads as
      // text however it was stored.
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

      // Four reads and no more: a page pointing at where it already is would be read forever.
      assert.strictEqual(mockedExecute.mock.calls.length, 4);
      // And what was read is not the whole change, so the file nobody listed is left unanswered
      // rather than reported as gone from the change request.
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
      // Nothing was marked, so Azure was not asked at all.
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads the conversation through the REST API, pinned to a version", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
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
      // `az devops invoke` rather than `az rest`: it signs in the way the azure-devops extension
      // does, and `az rest` mints its own token against whichever tenant `az` defaults to.
      expect(argsOfCall(0)).toContain("invoke");
      expect(argsOfCall(0)).toContain("pullRequestThreads");
      expect(argsOfCall(0)).toContain("project=platform");
      expect(argsOfCall(0)).toContain("repositoryId=web");
      expect(argsOfCall(0)).toContain("pullRequestId=42");
      // A review's threads grow with how long it ran, and this route does not page, so the read
      // asks for more than the process default rather than taking whatever it is given.
      expect(maxOutputBytesOfCall(0)).toBeGreaterThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
    }),
  );

  it.effect("reads a long review's threads, which are past the default output limit", () =>
    Effect.gen(function* () {
      const response = json({ value: threadRows(800) });
      // Azure opens a thread per vote and per ref update beside the ones people wrote, and every
      // comment carries a full identity, so a review argued over for weeks outgrows the default.
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
      // This route does not page, so the whole history arrives at once. Cut at the default it is
      // JSON stopping mid-string, and every diff and file revision read on this host fails with
      // it, since each of them starts by asking which iteration is the latest.
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
      // Azure's own maximum for this route, and every entry carries a path, a url and three
      // object ids, so an ordinary page of a large change already outgrows the default.
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

      // Cut at the default this would arrive as JSON stopping mid-string, and a perfectly
      // ordinary page would be reported as a host answering with nonsense.
      assert.strictEqual(page.changes.length, 2_000);
      assert.isFalse(page.truncated);
    }),
  );

  it.effect("reads a file whose JSON envelope is past the default output limit", () =>
    Effect.gen(function* () {
      // Under a megabyte as bytes on the host, so this is a file the other hosts hand over.
      const file = "const value = 1;\n".repeat(57_000);
      const response = json({ content: file });
      expect(Buffer.byteLength(file)).toBeLessThan(VCS_DEFAULT_MAX_OUTPUT_BYTES);
      // And past it once Azure wraps it, because there is no route here that serves the bytes.
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

      // The path carried around here has had Azure's leading slash taken off so it matches the
      // patch and the viewed mark. The items route is documented in Azure's spelling, so it goes
      // back on the way out rather than being sent as the shorter name.
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
            // Well-formed, but with nothing to build a link from: not a decode failure.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
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
