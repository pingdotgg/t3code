import { assert, afterEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitHubCli,
  GitHubCliAuthenticationError,
  GitHubCliCommandError,
  type GitHubCliError,
  type GitHubPullRequestCheck,
  type GitHubPullRequestDetail,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
  type GitHubPullRequestSummary,
} from "../../sourceControl/GitHubCli.ts";
import {
  SourceControlProviderRegistry,
  type SourceControlProviderHandle,
} from "../../sourceControl/SourceControlProviderRegistry.ts";
import { MergeGitPort, type MergeGitResult } from "../Services/TicketMergeService.ts";
import { GitHubPort } from "../Services/GitHubPort.ts";
import { GitHubPortLive } from "./GitHubPort.ts";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const ghError = (detail: string): GitHubCliError => {
  const lower = detail.toLowerCase();
  if (lower.includes("not authenticated") || lower.includes("gh auth login") || lower.includes("not available on path")) {
    return new GitHubCliAuthenticationError({ command: "gh", cwd: "/repo", cause: new Error(detail) });
  }
  return new GitHubCliCommandError({ command: "gh", cwd: "/repo", cause: new Error(detail) });
};

const unimplemented = (name: string) => () =>
  Effect.fail(new GitHubCliCommandError({ command: "gh", cwd: "/repo", cause: new Error(`unexpected ${name}`) }));

const githubHandle = (remoteUrl: string, remoteName = "origin"): SourceControlProviderHandle => ({
  provider: {} as SourceControlProviderHandle["provider"],
  context: {
    provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    remoteName,
    remoteUrl,
  },
});

const registryLayer = (handle: SourceControlProviderHandle | null) =>
  Layer.succeed(SourceControlProviderRegistry, {
    get: unimplemented("get") as never,
    resolve: unimplemented("resolve") as never,
    discover: Effect.succeed([]),
    resolveHandle: () =>
      handle === null
        ? Effect.succeed({
            provider: {} as SourceControlProviderHandle["provider"],
            context: null,
          })
        : Effect.succeed(handle),
  });

interface GhStubs {
  readonly execute?: GitHubCli["Service"]["execute"];
  readonly getDefaultBranch?: GitHubCli["Service"]["getDefaultBranch"];
  readonly listOpenPullRequests?: GitHubCli["Service"]["listOpenPullRequests"];
  readonly createPullRequest?: GitHubCli["Service"]["createPullRequest"];
  readonly mergePullRequest?: GitHubCli["Service"]["mergePullRequest"];
  readonly getPullRequestDetail?: GitHubCli["Service"]["getPullRequestDetail"];
  readonly listPullRequestChecks?: GitHubCli["Service"]["listPullRequestChecks"];
  readonly listPullRequestReviews?: GitHubCli["Service"]["listPullRequestReviews"];
  readonly listPullRequestReviewComments?: GitHubCli["Service"]["listPullRequestReviewComments"];
  readonly getRepositoryCloneUrls?: GitHubCli["Service"]["getRepositoryCloneUrls"];
}

const ghLayer = (stubs: GhStubs) =>
  Layer.succeed(GitHubCli, {
    execute: stubs.execute ?? (unimplemented("execute") as never),
    listOpenPullRequests:
      stubs.listOpenPullRequests ?? (unimplemented("listOpenPullRequests") as never),
    getPullRequest: unimplemented("getPullRequest") as never,
    getRepositoryCloneUrls:
      stubs.getRepositoryCloneUrls ?? (unimplemented("getRepositoryCloneUrls") as never),
    createRepository: unimplemented("createRepository") as never,
    createPullRequest: stubs.createPullRequest ?? (unimplemented("createPullRequest") as never),
    getDefaultBranch: stubs.getDefaultBranch ?? (unimplemented("getDefaultBranch") as never),
    checkoutPullRequest: unimplemented("checkoutPullRequest") as never,
    mergePullRequest: stubs.mergePullRequest ?? (unimplemented("mergePullRequest") as never),
    getPullRequestDetail:
      stubs.getPullRequestDetail ?? (unimplemented("getPullRequestDetail") as never),
    listPullRequestChecks:
      stubs.listPullRequestChecks ?? (unimplemented("listPullRequestChecks") as never),
    listPullRequestReviews:
      stubs.listPullRequestReviews ?? (unimplemented("listPullRequestReviews") as never),
    listPullRequestReviewComments:
      stubs.listPullRequestReviewComments ??
      (unimplemented("listPullRequestReviewComments") as never),
  });

interface RecordedGitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

const gitLayer = (
  script: (input: { cwd: string; args: ReadonlyArray<string> }) => MergeGitResult,
  calls: RecordedGitCall[],
) =>
  Layer.succeed(MergeGitPort, {
    run: (input) => {
      calls.push({ cwd: input.cwd, args: input.args });
      return Effect.succeed(script({ cwd: input.cwd, args: input.args }));
    },
  });

const gitResult = (overrides: Partial<MergeGitResult> = {}): MergeGitResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  ...overrides,
});

const tempFiles: Array<{ path: string; content: string }> = [];

const fsLayer = Layer.mock(FileSystem.FileSystem)({
  makeTempFileScoped: () => Effect.succeed("/tmp/t3-pr-body-stub"),
  writeFileString: (path: string, content: string) =>
    Effect.sync(() => {
      tempFiles.push({ path, content });
    }),
} as never);

const detail = (overrides: Partial<GitHubPullRequestDetail> = {}): GitHubPullRequestDetail => ({
  state: "OPEN",
  mergedAt: null,
  reviewDecision: null,
  headRefOid: "sha-abc",
  url: "https://github.com/o/r/pull/7",
  ...overrides,
});

const check = (overrides: Partial<GitHubPullRequestCheck> = {}): GitHubPullRequestCheck => ({
  name: "build",
  state: "SUCCESS",
  bucket: "pass",
  link: "",
  ...overrides,
});

const review = (overrides: Partial<GitHubPullRequestReview> = {}): GitHubPullRequestReview => ({
  id: "PRR_1",
  author: "alice",
  state: "COMMENTED",
  body: "looks ok",
  submittedAt: "2026-06-12T10:00:00Z",
  ...overrides,
});

const comment = (
  overrides: Partial<GitHubPullRequestReviewComment> = {},
): GitHubPullRequestReviewComment => ({
  id: 1,
  user: "bob",
  body: "nit",
  path: "src/x.ts",
  createdAt: "2026-06-12T09:00:00Z",
  ...overrides,
});

const prSummary = (
  overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary => ({
  number: 7,
  title: "My PR",
  url: "https://github.com/o/r/pull/7",
  baseRefName: "main",
  headRefName: "feature/x",
  ...overrides,
});

afterEach(() => {
  tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubPortLive", () => {
  describe("resolveRemote", () => {
    it.effect("derives repo from the remote url", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.resolveRemote("/repo");
        assert.deepStrictEqual(result, { remoteName: "origin", repo: "octocat/repo" });
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(ghLayer({})),
            Layer.provide(registryLayer(githubHandle("https://github.com/octocat/repo.git"))),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("falls back to gh repo view for unparseable urls", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.resolveRemote("/repo");
        assert.deepStrictEqual(result, { remoteName: "origin", repo: "octocat/ghe-repo" });
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                getRepositoryCloneUrls: () =>
                  Effect.succeed({
                    nameWithOwner: "octocat/ghe-repo",
                    url: "https://ghe.corp/octocat/ghe-repo",
                    sshUrl: "git@ghe.corp:octocat/ghe-repo.git",
                  }),
              }),
            ),
            Layer.provide(registryLayer(githubHandle("https://ghe.corp/octocat/ghe-repo.git"))),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });

  describe("preflight", () => {
    it.effect("returns ok when gh auth status succeeds", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.preflight("/repo");
        assert.deepStrictEqual(result, { ok: true });
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                execute: () =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "ok",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("returns not-ok on auth failure", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.preflight("/repo");
        assert.equal(result.ok, false);
        if (result.ok === false) {
          assert.equal(result.reason.includes("not authenticated"), true);
        }
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                execute: () =>
                  Effect.fail(
                    ghError("GitHub CLI is not authenticated. Run `gh auth login` and retry."),
                  ),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("propagates unexpected gh failures to the error channel", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const error = yield* port.preflight("/repo").pipe(Effect.flip);
        assert.equal(error.message.includes("preflight"), true);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                execute: () => Effect.fail(ghError("network unreachable")),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });

  describe("openPr", () => {
    const openInput = {
      cwd: "/repo",
      branch: "feature/x",
      base: "main",
      title: "My PR",
      body: "the body",
      draft: false,
    };

    it.effect("adopts an existing PR without creating one", () => {
      const calls: RecordedGitCall[] = [];
      return Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.openPr(openInput);
        assert.deepStrictEqual(result, {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          adopted: true,
        });
        // push happened, no create attempted (createPullRequest stub fails)
        assert.equal(calls.length, 1);
        assert.deepStrictEqual(calls[0]!.args, [
          "push",
          "-u",
          "origin",
          "HEAD:refs/heads/feature/x",
        ]);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                listOpenPullRequests: () => Effect.succeed([prSummary()]),
                createPullRequest: () =>
                  Effect.fail(ghError("createPullRequest should not be called")),
              }),
            ),
            Layer.provide(registryLayer(githubHandle("https://github.com/octocat/repo.git"))),
            Layer.provide(gitLayer(() => gitResult(), calls)),
            Layer.provide(fsLayer),
          ),
        ),
      );
    });

    it.effect("creates a draft PR via a temp body file when none exists", () => {
      const createCalls: Array<{ bodyFile: string; draft: boolean | undefined }> = [];
      let listCount = 0;
      return Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.openPr({ ...openInput, draft: true });
        assert.deepStrictEqual(result, {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          adopted: false,
        });
        assert.equal(createCalls.length, 1);
        assert.equal(createCalls[0]!.draft, true);
        assert.equal(createCalls[0]!.bodyFile, "/tmp/t3-pr-body-stub");
        assert.deepStrictEqual(tempFiles, [{ path: "/tmp/t3-pr-body-stub", content: "the body" }]);
        assert.equal(listCount, 2);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                listOpenPullRequests: () =>
                  Effect.sync(() => {
                    listCount += 1;
                    return listCount === 1 ? [] : [prSummary()];
                  }),
                createPullRequest: (input) =>
                  Effect.sync(() => {
                    createCalls.push({ bodyFile: input.bodyFile, draft: input.draft });
                  }),
              }),
            ),
            Layer.provide(registryLayer(githubHandle("https://github.com/octocat/repo.git"))),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      );
    });

    it.effect("maps a rejected push to branch diverged", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const error = yield* port.openPr(openInput).pipe(Effect.flip);
        assert.equal(error.message.startsWith("branch diverged"), true);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(ghLayer({})),
            Layer.provide(registryLayer(githubHandle("https://github.com/octocat/repo.git"))),
            Layer.provide(
              gitLayer(
                () =>
                  gitResult({
                    exitCode: 1,
                    stderr: "! [rejected] feature/x -> feature/x (non-fast-forward)",
                  }),
                [],
              ),
            ),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });

  describe("findPrForBranch", () => {
    it.effect("returns the first open PR for the head selector", () => {
      const selectors: Array<string | undefined> = [];
      return Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.findPrForBranch({ cwd: "/repo", branch: "workflow/ticket-x" });
        assert.deepStrictEqual(result, { number: 7, url: "https://github.com/o/r/pull/7" });
        assert.deepStrictEqual(selectors, ["workflow/ticket-x"]);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                listOpenPullRequests: (input) =>
                  Effect.sync(() => {
                    selectors.push(input.headSelector);
                    return [prSummary({ number: 7 }), prSummary({ number: 9 })];
                  }),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      );
    });

    it.effect("returns null when no open PR matches the branch", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.findPrForBranch({ cwd: "/repo", branch: "workflow/ticket-x" });
        assert.equal(result, null);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(ghLayer({ listOpenPullRequests: () => Effect.succeed([]) })),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });

  describe("prDetail ciState mapping", () => {
    const runDetail = (input: {
      detail?: Partial<GitHubPullRequestDetail>;
      checks: ReadonlyArray<GitHubPullRequestCheck>;
    }) =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        return yield* port.prDetail({ cwd: "/repo", prNumber: 7 });
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                getPullRequestDetail: () => Effect.succeed(detail(input.detail)),
                listPullRequestChecks: () => Effect.succeed(input.checks),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      );

    it.effect("empty checks → success", () =>
      Effect.gen(function* () {
        const result = yield* runDetail({ checks: [] });
        assert.equal(result.ciState, "success");
      }),
    );

    it.effect("any fail bucket → failure", () =>
      Effect.gen(function* () {
        const result = yield* runDetail({
          checks: [check({ bucket: "pass" }), check({ name: "t", bucket: "fail" })],
        });
        assert.equal(result.ciState, "failure");
      }),
    );

    it.effect("cancel bucket → failure", () =>
      Effect.gen(function* () {
        const result = yield* runDetail({ checks: [check({ bucket: "cancel" })] });
        assert.equal(result.ciState, "failure");
      }),
    );

    it.effect("pending bucket (no failures) → pending", () =>
      Effect.gen(function* () {
        const result = yield* runDetail({
          checks: [check({ bucket: "pass" }), check({ name: "t", bucket: "pending" })],
        });
        assert.equal(result.ciState, "pending");
      }),
    );

    it.effect("all pass/skipping → success", () =>
      Effect.gen(function* () {
        const result = yield* runDetail({
          checks: [check({ bucket: "pass" }), check({ name: "t", bucket: "skipping" })],
        });
        assert.equal(result.ciState, "success");
      }),
    );

    it.effect("maps state and reviewDecision", () =>
      Effect.gen(function* () {
        const merged = yield* runDetail({
          detail: { state: "OPEN", mergedAt: "2026-06-12T10:00:00Z" },
          checks: [],
        });
        assert.equal(merged.state, "merged");

        const approved = yield* runDetail({
          detail: { reviewDecision: "APPROVED" },
          checks: [],
        });
        assert.equal(approved.reviewDecision, "approved");

        const changes = yield* runDetail({
          detail: { reviewDecision: "CHANGES_REQUESTED" },
          checks: [],
        });
        assert.equal(changes.reviewDecision, "changes_requested");

        const closed = yield* runDetail({ detail: { state: "CLOSED" }, checks: [] });
        assert.equal(closed.state, "closed");
        assert.equal(closed.reviewDecision, "none");
      }),
    );
  });

  describe("mergePr", () => {
    const mergeInput = {
      cwd: "/repo",
      prNumber: 7,
      strategy: "squash" as const,
      deleteBranch: false,
      branch: "feature/x",
      remoteName: "origin",
    };

    it.effect("returns ok:false when gh reports not mergeable", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.mergePr(mergeInput);
        assert.equal(result.ok, false);
        if (result.ok === false) {
          assert.equal(result.reason.toLowerCase().includes("branch protection"), true);
        }
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                mergePullRequest: () =>
                  Effect.fail(ghError("Pull request is not mergeable: branch protection rules.")),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("deletes the remote branch best-effort on success", () => {
      const calls: RecordedGitCall[] = [];
      return Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.mergePr({ ...mergeInput, deleteBranch: true });
        assert.deepStrictEqual(result, { ok: true });
        assert.equal(calls.length, 1);
        assert.deepStrictEqual(calls[0]!.args, ["push", "origin", "--delete", "feature/x"]);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                mergePullRequest: () => Effect.void,
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), calls)),
            Layer.provide(fsLayer),
          ),
        ),
      );
    });

    it.effect("propagates unexpected merge failures to the error channel", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const error = yield* port.mergePr(mergeInput).pipe(Effect.flip);
        assert.equal(error.message.includes("merge"), true);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                mergePullRequest: () => Effect.fail(ghError("boom unexpected internal error")),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("treats a transient error mentioning pending as infra, not not-mergeable", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const error = yield* port.mergePr(mergeInput).pipe(Effect.flip);
        assert.equal(error.message.includes("merge"), true);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                mergePullRequest: () =>
                  Effect.fail(ghError("network error: request pending, timed out")),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("does not reclassify an infra fault that merely mentions 'checks'", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        // An API/network fault that happens to contain the word "checks" must
        // surface as an error, not a blocked (not-mergeable) outcome.
        const error = yield* port.mergePr(mergeInput).pipe(Effect.flip);
        assert.equal(error.message.includes("merge"), true);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                mergePullRequest: () =>
                  Effect.fail(ghError("could not query required status checks: API unavailable")),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });

  describe("failingCheckLogs", () => {
    it.effect("returns null when no checks fail", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.failingCheckLogs({ cwd: "/repo", prNumber: 7 });
        assert.equal(result, null);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({ listPullRequestChecks: () => Effect.succeed([check({ bucket: "pass" })]) }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("parses a run id from the failing check link and fetches log tail", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.failingCheckLogs({ cwd: "/repo", prNumber: 7 });
        assert.equal(result !== null && result.length === 10_000, true);
        assert.equal(result?.endsWith("END"), true);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                listPullRequestChecks: () =>
                  Effect.succeed([
                    check({
                      name: "test",
                      bucket: "fail",
                      link: "https://github.com/o/r/actions/runs/9988/job/1",
                    }),
                  ]),
                execute: () =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: `${"x".repeat(10_050)}END`,
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );

    it.effect("falls back to check names when no run id is parseable", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.failingCheckLogs({ cwd: "/repo", prNumber: 7 });
        assert.equal(result, "lint, typecheck");
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                listPullRequestChecks: () =>
                  Effect.succeed([
                    check({ name: "lint", bucket: "fail", link: "https://example.com/no-run" }),
                    check({ name: "typecheck", bucket: "fail", link: "" }),
                  ]),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });

  describe("listReviewFeedback", () => {
    it.effect("merges reviews and comments, skips empties, sorts ascending", () =>
      Effect.gen(function* () {
        const port = yield* GitHubPort;
        const result = yield* port.listReviewFeedback({
          cwd: "/repo",
          prNumber: 7,
          repo: "o/r",
        });
        assert.deepStrictEqual(result, [
          {
            id: "comment:1",
            author: "bob",
            body: "nit",
            submittedAt: "2026-06-12T09:00:00Z",
          },
          {
            id: "PRR_1",
            author: "alice",
            body: "looks ok",
            submittedAt: "2026-06-12T10:00:00Z",
          },
        ]);
      }).pipe(
        Effect.provide(
          GitHubPortLive.pipe(
            Layer.provide(
              ghLayer({
                listPullRequestReviews: () =>
                  Effect.succeed([
                    review(),
                    review({ id: "PRR_2", body: "   ", submittedAt: "2026-06-12T11:00:00Z" }),
                  ]),
                listPullRequestReviewComments: () =>
                  Effect.succeed([
                    comment(),
                    comment({ id: 2, body: "", createdAt: "2026-06-12T08:00:00Z" }),
                  ]),
              }),
            ),
            Layer.provide(registryLayer(null)),
            Layer.provide(gitLayer(() => gitResult(), [])),
            Layer.provide(fsLayer),
          ),
        ),
      ),
    );
  });
});
