import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import {
  ProjectId,
  GitCommandError,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestStack,
  type PullRequestRef,
} from "@t3tools/contracts";
import type { ReviewGuideGenerationInput } from "@t3tools/provider-core/server/textGeneration";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PullRequestReviewGuideService from "./PullRequestReviewGuideService.ts";
import * as PullRequestService from "./PullRequestService.ts";

const projectId = ProjectId.make("project-1");
const ACME_APP = {
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/app.git",
  },
  provider: "github",
  displayName: "acme/app",
  owner: "acme",
  name: "app",
};

const reference: PullRequestRef = {
  projectId,
  host: "github.com",
  repository: "acme/app",
  number: 7,
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

const makeRepositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-guide-" });
  const remote = `${root}/remote`;
  const workspace = `${root}/workspace`;
  yield* fs.makeDirectory(remote);
  yield* git(remote, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(remote, ["config", "user.email", "test@example.com"]);
  yield* git(remote, ["config", "user.name", "Test"]);
  const commit = (path: string, message: string, contents = message) =>
    fs
      .writeFileString(`${remote}/${path}`, contents)
      .pipe(
        Effect.andThen(git(remote, ["add", path])),
        Effect.andThen(git(remote, ["commit", "--quiet", "-m", message])),
        Effect.andThen(git(remote, ["rev-parse", "HEAD"])),
      );
  yield* commit("base.txt", "base");
  yield* git(remote, ["checkout", "--quiet", "-b", "stack-base"]);
  const lowerSha = yield* commit("lower.txt", "lower layer");
  yield* git(remote, ["checkout", "--quiet", "-b", "feature"]);
  const headSha = yield* commit(
    "feature.txt",
    "the change",
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
  );
  yield* git(remote, ["checkout", "--quiet", "-b", "upper"]);
  const upperSha = yield* commit("upper.txt", "upper layer");
  yield* git(remote, ["checkout", "--quiet", "main"]);
  yield* commit("unrelated.txt", "main moved on");
  yield* git(root, ["clone", "--quiet", remote, workspace]);
  return { root, workspace, headSha, lowerSha, upperSha };
});

const detail = (workspaceRoot: string, headSha: string): PullRequestDetail =>
  ({
    number: 7,
    title: "Add the feature",
    body: "Adds the feature.",
    baseBranch: "stack-base",
    headBranch: "feature",
    headSha,
    workspaceRoot,
  }) as PullRequestDetail;

const activity: PullRequestActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
};

const stack = (repositories: {
  readonly headSha: string;
  readonly lowerSha: string;
  readonly upperSha: string;
}): PullRequestStack => ({
  id: "stack",
  number: 1,
  url: "https://example.com/stack/1",
  base: "main",
  layers: [
    {
      number: 6,
      title: "Lower",
      headSha: repositories.lowerSha,
      headBranch: "stack-base",
      state: "open",
    },
    {
      number: 7,
      title: "Add the feature",
      headSha: repositories.headSha,
      headBranch: "feature",
      state: "open",
    },
    {
      number: 8,
      title: "Upper",
      headSha: repositories.upperSha.slice(0, 12),
      headBranch: "upper",
      state: "open",
    },
    { number: 9, title: "Unpushed", headSha: "f".repeat(40), headBranch: "gone", state: "open" },
  ],
});

const makeLayer = (input: {
  readonly root: string;
  readonly workspace: string;
  readonly headSha: string;
  readonly lowerSha: string;
  readonly upperSha: string;
  readonly generate: TextGeneration.TextGeneration["Service"]["generateReviewGuide"];
  readonly stored: Deferred.Deferred<void>;
  readonly enabled?: boolean;
  readonly currentHead?: Ref.Ref<string>;
  readonly identity?: typeof ACME_APP;
}) =>
  PullRequestReviewGuideService.layer.pipe(
    Layer.provide(
      Layer.effect(
        PullRequestReviewGuides.PullRequestReviewGuideRepository,
        Effect.gen(function* () {
          const repository = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
          return {
            get: repository.get,
            put: (key, guide) =>
              repository
                .put(key, guide)
                .pipe(Effect.tap(() => Deferred.succeed(input.stored, undefined))),
          } satisfies PullRequestReviewGuides.PullRequestReviewGuideRepository["Service"];
        }),
      ).pipe(Layer.provide(PullRequestReviewGuides.layer)),
    ),
    Layer.provide(
      Layer.succeed(PullRequestService.PullRequestService, {
        detail: () =>
          (input.currentHead === undefined
            ? Effect.succeed(input.headSha)
            : Ref.get(input.currentHead)
          ).pipe(Effect.map((head) => detail(input.workspace, head))),
        activity: () => Effect.succeed(activity),
        invalidate: () => Effect.void,
        stack: () => Effect.succeed(stack(input)),
      } as unknown as PullRequestService.PullRequestService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        getShell: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: input.workspace,
            repositoryIdentity: input.identity ?? ACME_APP,
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    ),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateReviewGuide: input.generate,
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
    Layer.provide(ServerSettings.layerTest({ reviewGuidesEnabled: input.enabled ?? true })),
    Layer.provide(ServerConfig.layerTest(input.root, { prefix: "t3-review-guide-config-" })),
  );

const layerBase = Layer.mergeAll(
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-guide-git-" })),
    Layer.provideMerge(VcsProcess.layer),
  ),
  SqlitePersistence.layerMemory,
).pipe(Layer.provideMerge(NodeServices.layer));

type Repositories = Effect.Success<typeof makeRepositories>;

const awaitRunFailure = (
  service: PullRequestReviewGuideService.PullRequestReviewGuideService["Service"],
  input: PullRequestRef,
) =>
  service.get(input).pipe(
    Effect.flatMap((result) =>
      result.run?._tag === "Failed"
        ? Effect.succeed(result.run.detail)
        : Effect.fail("still running" as const),
    ),
    Effect.retry(Schedule.spaced("20 millis")),
  );

const startSingleBranchRun = (input: {
  readonly repositoryName: string;
  readonly reportedHead: (repositories: Repositories) => string;
  readonly refuseCommitFetch: boolean;
  readonly prepare: (
    repositories: Repositories,
    workspace: string,
  ) => Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver>;
  readonly onBranchFetch?:
    | ((
        repositories: Repositories,
      ) => Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver>)
    | undefined;
}) =>
  Effect.gen(function* () {
    const repositories = yield* makeRepositories;
    const workspace = `${repositories.root}/single-branch`;
    yield* git(repositories.root, [
      "clone",
      "--quiet",
      "--no-local",
      "--single-branch",
      "--branch",
      "main",
      `${repositories.root}/remote`,
      workspace,
    ]);
    yield* input.prepare(repositories, workspace);
    const reportedHead = input.reportedHead(repositories);
    const stored = yield* Deferred.make<void>();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fetchedRefs: Array<string> = [];
    const observed: Array<{ cwd: string; head: string; changed: string }> = [];
    const onBranchFetch = input.onBranchFetch;
    const observedDriver = {
      ...driver,
      execute: (call: GitVcsDriver.ExecuteGitInput) =>
        Effect.gen(function* () {
          const ref = call.args.at(-1);
          if (call.args[0] !== "fetch" || ref === undefined) return yield* driver.execute(call);
          fetchedRefs.push(ref);
          if (input.refuseCommitFetch && ref === repositories.headSha) {
            return yield* new GitCommandError({
              operation: call.operation,
              command: "git",
              cwd: call.cwd,
              detail: "The test remote refuses fetches by commit.",
              exitCode: 128,
            });
          }
          if (ref === "refs/heads/feature" && onBranchFetch !== undefined) {
            yield* onBranchFetch(repositories).pipe(
              Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
            );
          }
          return yield* driver.execute(call);
        }),
    };
    const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
      driver
        .execute({ operation: "test.readCheckout", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const context = yield* Layer.build(
      makeLayer({
        ...repositories,
        headSha: reportedHead,
        workspace,
        stored,
        identity: {
          ...ACME_APP,
          canonicalKey: `github.com/acme/${input.repositoryName}`,
          displayName: `acme/${input.repositoryName}`,
          name: input.repositoryName,
        },
        generate: (generation) =>
          Effect.gen(function* () {
            observed.push({
              cwd: generation.cwd,
              head: yield* readCheckout(generation.cwd, ["rev-parse", "HEAD"]),
              changed: yield* readCheckout(generation.cwd, [
                "diff",
                "--name-only",
                `${generation.baseCommit}...HEAD`,
              ]),
            });
            return { stops: [] };
          }).pipe(Effect.orDie),
      }).pipe(Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, observedDriver))),
    );
    const service = Context.get(
      context,
      PullRequestReviewGuideService.PullRequestReviewGuideService,
    );
    const guideReference = { ...reference, repository: `acme/${input.repositoryName}` };
    yield* service.generate(guideReference);
    return {
      repositories,
      reportedHead,
      service,
      reference: guideReference,
      stored,
      fetchedRefs,
      observed,
    };
  });

// Runs drive real git, which the test clock does not advance, so waits use real time.
it.layer(layerBase, { excludeTestServices: true })("PullRequestReviewGuideService", (it) => {
  it.effect.each([
    {
      name: "a short head already fetched",
      shortHash: true,
      prepare: "fetch-feature",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: [],
    },
    {
      name: "a short head on its branch",
      shortHash: true,
      prepare: "none",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: ["refs/heads/feature"],
    },
    {
      name: "a short head whose branch moves during the fetch",
      shortHash: true,
      prepare: "none",
      pushDuringFetch: true,
      refuseCommitFetch: true,
      expectedFetches: ["refs/heads/feature"],
    },
    {
      name: "a full head served by commit",
      shortHash: false,
      prepare: "none",
      pushDuringFetch: false,
      refuseCommitFetch: false,
      expectedFetches: ["<head>"],
    },
    {
      name: "a full head on its branch",
      shortHash: false,
      prepare: "none",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: ["<head>", "refs/heads/feature"],
    },
    {
      name: "a full head only on its pull ref",
      shortHash: false,
      prepare: "refs/pull/7/head",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: ["<head>", "refs/heads/feature", "refs/pull/7/head"],
    },
    {
      name: "a full head only on its merge request ref",
      shortHash: false,
      prepare: "refs/merge-requests/7/head",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: [
        "<head>",
        "refs/heads/feature",
        "refs/pull/7/head",
        "refs/merge-requests/7/head",
      ],
    },
  ])(
    "writes a guide for the reported commit: $name",
    ({ shortHash, prepare, pushDuringFetch, refuseCommitFetch, expectedFetches }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* startSingleBranchRun({
            repositoryName: "fetched-head",
            reportedHead: (repositories) =>
              shortHash ? repositories.headSha.slice(0, 12) : repositories.headSha,
            refuseCommitFetch,
            prepare: (repositories, workspace) => {
              const remote = `${repositories.root}/remote`;
              if (prepare === "fetch-feature") {
                return git(workspace, ["fetch", "--quiet", "origin", "feature"]).pipe(
                  Effect.asVoid,
                );
              }
              if (prepare === "none") return Effect.void;
              return git(remote, ["update-ref", prepare, repositories.headSha]).pipe(
                Effect.andThen(
                  git(remote, ["update-ref", "refs/heads/feature", repositories.lowerSha]),
                ),
                Effect.asVoid,
              );
            },
            onBranchFetch: pushDuringFetch
              ? (repositories) => {
                  const remote = `${repositories.root}/remote`;
                  return git(remote, ["checkout", "--quiet", "feature"]).pipe(
                    Effect.andThen(
                      git(remote, [
                        "commit",
                        "--quiet",
                        "--allow-empty",
                        "-m",
                        "push during fetch",
                      ]),
                    ),
                    Effect.asVoid,
                  );
                }
              : undefined,
          });
          yield* Effect.raceFirst(
            Deferred.await(run.stored),
            awaitRunFailure(run.service, run.reference).pipe(
              Effect.flatMap((detail) => Effect.die(`run failed: ${detail}`)),
            ),
          );
          const { headSha } = run.repositories;
          const result = yield* run.service.get(run.reference);
          assert.strictEqual(result.guide?.headSha, run.reportedHead);
          assert.deepStrictEqual(result.guide?.stops[0]?.files, [{ path: "feature.txt" }]);
          assert.deepStrictEqual(run.observed, [
            { cwd: run.observed[0]?.cwd, head: headSha, changed: "feature.txt" },
          ]);
          const headRefs = new Set([
            headSha,
            run.reportedHead,
            "refs/heads/feature",
            "refs/pull/7/head",
            "refs/merge-requests/7/head",
          ]);
          assert.deepStrictEqual(
            run.fetchedRefs.filter((ref) => headRefs.has(ref)),
            expectedFetches.map((ref) => (ref === "<head>" ? headSha : ref)),
          );
          const fs = yield* FileSystem.FileSystem;
          assert.isFalse(yield* fs.exists(run.observed[0]?.cwd ?? ""));
        }),
      ),
  );

  it.effect.each([
    {
      name: "a branch named like the short head",
      reportedHead: (repositories: Repositories) => repositories.headSha.slice(0, 12),
      shadow: "branch",
      expected: ["a branch or tag rather than the commit"],
    },
    {
      name: "a tag named like the short head",
      reportedHead: (repositories: Repositories) => repositories.headSha.slice(0, 12),
      shadow: "tag",
      expected: ["a branch or tag rather than the commit"],
    },
    {
      name: "a head that is not a commit hash",
      reportedHead: (repositories: Repositories) =>
        `--upload-pack=touch ${repositories.root}/injected`,
      shadow: "none",
      expected: ["not a commit hash"],
    },
    {
      name: "a head no source has",
      reportedHead: () => "e".repeat(40),
      shadow: "none",
      expected: [
        "local objects:",
        "the commit:",
        "branch feature:",
        "refs/pull/7/head:",
        "refs/merge-requests/7/head:",
      ],
    },
  ])("refuses to write a guide for $name", ({ reportedHead, shadow, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startSingleBranchRun({
          repositoryName: "refused-head",
          reportedHead,
          refuseCommitFetch: false,
          prepare: (repositories, workspace) =>
            git(workspace, ["fetch", "--quiet", "origin", "feature"]).pipe(
              Effect.andThen(
                shadow === "none"
                  ? Effect.void
                  : git(workspace, [shadow, repositories.headSha.slice(0, 12), "HEAD"]),
              ),
              Effect.asVoid,
            ),
        });
        const detail = yield* Effect.raceFirst(
          awaitRunFailure(run.service, run.reference),
          Deferred.await(run.stored).pipe(Effect.andThen(Effect.die("a guide was written"))),
        );
        for (const part of expected) assert.include(detail, part);
        assert.deepStrictEqual(run.observed, []);
        assert.isFalse(run.fetchedRefs.some((ref) => ref.startsWith("-")));
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(`${run.repositories.root}/injected`));
      }),
    ),
  );

  it.effect("briefs the change against its own base in a checkout it then removes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const seen = yield* Deferred.make<{
          readonly input: ReviewGuideGenerationInput;
          readonly changed: string;
          readonly head: string;
          readonly upper: string;
        }>();
        const finish = yield* Deferred.make<void>();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
          git(cwd, args).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
            Effect.orDie,
          );
        const stored = yield* Deferred.make<void>();

        // Built in this test's scope: runs are forked into the service's scope and must outlive
        // the call that obtains the service.
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: (input) =>
              Effect.gen(function* () {
                const changed = yield* readCheckout(input.cwd, [
                  "diff",
                  "--name-only",
                  `${input.baseCommit}...HEAD`,
                ]);
                const head = yield* readCheckout(input.cwd, ["rev-parse", "HEAD"]);
                const upper = yield* readCheckout(input.cwd, [
                  "show",
                  `${repositories.upperSha}:upper.txt`,
                ]);
                yield* Deferred.succeed(seen, { input, changed, head, upper });
                yield* Deferred.await(finish);
                return {
                  stops: [
                    {
                      title: "The feature",
                      summary: "The change.",
                      attention: null,
                      excerpts: [
                        { path: "feature.txt", side: "new", start: 4, end: 40, caption: "" },
                      ],
                      files: [],
                      notes: [
                        { path: "feature.txt", line: 5, title: "Kept", body: "Inside." },
                        { path: "feature.txt", line: 30, title: "Dropped", body: "Outside." },
                      ],
                      questions: [],
                    },
                  ],
                };
              }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );

        const started = yield* service.generate(reference);
        assert.strictEqual(started.run?._tag, "Running");
        assert.strictEqual(started.guide, null);
        assert.isTrue(started.started);

        const failedRun = service.get(reference).pipe(
          Effect.flatMap((result) =>
            result.run?._tag === "Failed"
              ? Effect.die(`run failed: ${result.run.detail}`)
              : Effect.fail("still running" as const),
          ),
          Effect.retry(Schedule.spaced("20 millis")),
        );
        const observed = yield* Effect.raceFirst(Deferred.await(seen), failedRun);
        assert.strictEqual(observed.head, repositories.headSha);
        assert.strictEqual(observed.changed, "feature.txt");
        assert.strictEqual(observed.input.baseBranch, "stack-base");
        assert.deepStrictEqual(observed.input.stack, [
          { number: 6, title: "Lower", state: "open", headSha: repositories.lowerSha },
          { number: 7, title: "Add the feature", state: "open", headSha: repositories.headSha },
          { number: 8, title: "Upper", state: "open", headSha: repositories.upperSha },
          { number: 9, title: "Unpushed", state: "open", headSha: null },
        ]);
        assert.strictEqual(observed.upper, "upper layer");

        const joined = yield* service.generate(reference);
        assert.strictEqual(joined.run, started.run);
        assert.isFalse(joined.started);

        yield* Deferred.succeed(finish, undefined);
        yield* Deferred.await(stored);
        const finished = yield* service.get(reference);
        assert.strictEqual(finished.guide?.headSha, repositories.headSha);
        const guide = finished.guide;
        assert.isNotNull(guide);
        const [story] = guide.stops;
        assert.deepStrictEqual(story?.excerpts, [
          { path: "feature.txt", side: "new", start: 4, end: 10, caption: "" },
        ]);
        assert.deepStrictEqual(
          story?.notes.map((note) => note.title),
          ["Kept"],
        );
        assert.strictEqual(guide.stops.length, 1);

        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(observed.input.cwd));
        const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
        assert.notInclude(worktrees, observed.input.cwd);
      }),
    ),
  );

  it.effect("refuses to write a guide while the server has review guides off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            enabled: false,
            generate: () => Effect.die("a guide must not be written while the beta is off"),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const result = yield* Effect.flip(service.generate(reference));
        assert.include(result.message, "Review guides are off");
      }),
    ),
  );

  it.effect(
    "keeps a newer run's guide when an older run for the same pull request finishes late",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const stored = yield* Deferred.make<void>();
          const currentHead = yield* Ref.make(repositories.headSha);
          const releaseOld = yield* Deferred.make<void>();
          const oldStarted = yield* Deferred.make<void>();
          const answer = (title: string) => ({
            stops: [
              {
                title,
                summary: "",
                attention: null,
                excerpts: [],
                files: [],
                notes: [],
                questions: [],
              },
            ],
          });
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              stored,
              currentHead,
              generate: (input) =>
                input.cwd.length > 0 && input.baseCommit.length > 0
                  ? Ref.get(currentHead).pipe(
                      Effect.flatMap((head) =>
                        head === repositories.headSha
                          ? Deferred.succeed(oldStarted, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseOld)),
                              Effect.as(answer("old head")),
                            )
                          : Effect.succeed(answer("new head")),
                      ),
                    )
                  : Effect.die("unreachable"),
            }),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );

          yield* service.generate(reference);
          const firstFailed = service.get(reference).pipe(
            Effect.flatMap((result) =>
              result.run?._tag === "Failed"
                ? Effect.die(`first run failed: ${result.run.detail}`)
                : Effect.fail("still running" as const),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
          );
          yield* Effect.raceFirst(Deferred.await(oldStarted), firstFailed);
          yield* Ref.set(currentHead, repositories.upperSha);
          const second = yield* service.generate(reference);
          assert.strictEqual(second.run?._tag, "Running");
          assert.strictEqual(second.run?.headSha, repositories.upperSha);
          const failedRun = service.get(reference).pipe(
            Effect.flatMap((result) =>
              result.run?._tag === "Failed"
                ? Effect.die(`run failed: ${result.run.detail}`)
                : Effect.fail("still running" as const),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
          );
          yield* Effect.raceFirst(Deferred.await(stored), failedRun);

          yield* Deferred.succeed(releaseOld, undefined);
          const settled = yield* service.get(reference).pipe(
            Effect.filterOrFail(
              (result) => result.run === null,
              () => "still running" as const,
            ),
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
          );
          assert.strictEqual(settled.guide?.headSha, repositories.upperSha);
          yield* Effect.sleep("200 millis");
          const after = yield* service.get(reference);
          assert.isNull(after.run);
          assert.strictEqual(after.guide?.headSha, repositories.upperSha);
          assert.strictEqual(after.guide?.stops[0]?.title, "new head");
        }),
      ),
  );

  it.effect("refuses a pull request from a repository the project is not a checkout of", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            identity: {
              ...ACME_APP,
              canonicalKey: "github.com/acme/other",
              displayName: "acme/other",
              name: "other",
            },
            generate: () =>
              Effect.die("a guide must not be written from another repository's checkout"),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const result = yield* Effect.flip(service.generate(reference));
        assert.include(result.message, "in another repository");
      }),
    ),
  );
});
