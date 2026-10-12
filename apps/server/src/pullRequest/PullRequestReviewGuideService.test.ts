import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import {
  ProjectId,
  GitCommandError,
  SourceControlProviderKind,
  TextGenerationError,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestStack,
  type PullRequestRef,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type { ReviewGuideGenerationInput } from "@t3tools/provider-core/server/textGeneration";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PullRequestReviewGuideService from "./PullRequestReviewGuideService.ts";
import * as PullRequestService from "./PullRequestService.ts";

const projectId = ProjectId.make("project-1");
/** The test project is a checkout of the repository its pull requests come from. */
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

/**
 * A remote whose `main` has moved on past where the change's base branch left it, with the
 * change stacked on that base branch. A guide for the change must see only its own commit.
 */
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
  // Ten lines, so an excerpt reaching past them has something to be clamped to.
  const headSha = yield* commit(
    "feature.txt",
    "the change",
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
  );
  // A layer above the change, which uses what the change adds.
  yield* git(remote, ["checkout", "--quiet", "-b", "upper"]);
  const upperSha = yield* commit("upper.txt", "upper layer");
  yield* git(remote, ["checkout", "--quiet", "main"]);
  yield* commit("unrelated.txt", "main moved on");
  yield* git(root, ["clone", "--quiet", remote, workspace]);
  return { root, remote, workspace, headSha, lowerSha, upperSha };
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
    provider: SourceControlProviderKind.make("github"),
    repository: "acme/app",
  }) as PullRequestDetail;

const activity: PullRequestActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
};

/** The change as the middle layer of three; the top layer's head is not on any fetched branch. */
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
      headSha: repositories.upperSha,
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
  /** Completed when a run stores its guide, which is the last thing a run does but forget it. */
  readonly stored: Deferred.Deferred<void>;
  /** The server's beta switch; on unless a test is about it being off. */
  readonly enabled?: boolean;
  /** The head the host reports now, for a test that pushes between runs. */
  readonly currentHead?: Ref.Ref<string>;
  /** The project's own repository; defaults to the one the test reference names. */
  readonly identity?: RepositoryIdentity | null;
  readonly lookup?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["lookupRepository"];
  readonly detail?: Partial<PullRequestDetail>;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
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
          ).pipe(Effect.map((head) => ({ ...detail(input.workspace, head), ...input.detail }))),
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
            repositoryIdentity: input.identity === undefined ? ACME_APP : input.identity,
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(SourceControlRepositoryService.SourceControlRepositoryService, {
        lookupRepository:
          input.lookup ?? (() => Effect.die("a matching checkout must not need a clone lookup")),
      } as unknown as SourceControlRepositoryService.SourceControlRepositoryService["Service"]),
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
    Layer.provide(
      ServerSettings.layerTest({ reviewGuidesEnabled: input.enabled ?? true, ...input.settings }),
    ),
    Layer.provide(ServerConfig.layerTest(input.root, `${input.root}/server-home`)),
  );

const layerBase = Layer.mergeAll(
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-guide-git-" })),
    Layer.provideMerge(VcsProcess.layer),
  ),
  SqlitePersistence.layerMemory,
).pipe(Layer.provideMerge(NodeServices.layer));

// Runs drive real git, which the test clock does not advance, so waits use real time.
it.layer(layerBase, { excludeTestServices: true })("PullRequestReviewGuideService", (it) => {
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
        // The fake model reads the checkout with the same driver, captured so it needs nothing.
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
                // Another layer's head is readable from the checkout, to check a seam.
                const upper = yield* readCheckout(input.cwd, [
                  "show",
                  `${repositories.upperSha}:upper.txt`,
                ]);
                yield* Deferred.succeed(seen, { input, changed, head, upper });
                yield* Deferred.await(finish);
                // Written the way a model gets it wrong: an excerpt past the end of the file, a
                // note outside what is left of it, and a changed file left off the tour.
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

        // Generate returns while the run is still reading the change.
        const started = yield* service.generate(reference);
        assert.strictEqual(started.run?._tag, "Running");
        assert.strictEqual(started.guide, null);
        assert.isTrue(started.started);

        // A run that fails before reaching the model reports why rather than leaving this waiting.
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
        // The stack comes along, bottom first; a layer whose head could not be fetched is named
        // without one.
        assert.deepStrictEqual(observed.input.stack, [
          { number: 6, title: "Lower", state: "open", headSha: repositories.lowerSha },
          { number: 7, title: "Add the feature", state: "open", headSha: repositories.headSha },
          { number: 8, title: "Upper", state: "open", headSha: repositories.upperSha },
          { number: 9, title: "Unpushed", state: "open", headSha: null },
        ]);
        assert.strictEqual(observed.upper, "upper layer");

        // A second press while running joins the run instead of starting another.
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
        // lower.txt is below the change's base, so it is neither in the change nor on the tour.
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
          // The old run waits on this; the new one answers at once.
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
          // A push: the host reports the upper layer's commit as the head now, and a new run starts.
          yield* Ref.set(currentHead, repositories.upperSha);
          const second = yield* service.generate(reference);
          assert.strictEqual(second.run?._tag, "Running");
          assert.strictEqual(second.run?.headSha, repositories.upperSha);
          // A run that fails reports why rather than leaving this waiting.
          const failedRun = service.get(reference).pipe(
            Effect.flatMap((result) =>
              result.run?._tag === "Failed"
                ? Effect.die(`run failed: ${result.run.detail}`)
                : Effect.fail("still running" as const),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
          );
          yield* Effect.raceFirst(Deferred.await(stored), failedRun);

          // The old run finishes last. Its guide is for a head nobody is looking at any more.
          yield* Deferred.succeed(releaseOld, undefined);
          const settled = yield* service.get(reference).pipe(
            Effect.filterOrFail(
              (result) => result.run === null,
              () => "still running" as const,
            ),
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
          );
          assert.strictEqual(settled.guide?.headSha, repositories.upperSha);
          // Give the late run every chance to write over the newer guide; it must not.
          yield* Effect.sleep("200 millis");
          const after = yield* service.get(reference);
          assert.isNull(after.run);
          assert.strictEqual(after.guide?.headSha, repositories.upperSha);
          assert.strictEqual(after.guide?.stops[0]?.title, "new head");
        }),
      ),
  );

  it.effect.each(["private repository", "matching worktree"] as const)(
    "isolates the %s from inherited git repository variables",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const fs = yield* FileSystem.FileSystem;
          const unrelated = `${repositories.root}/inherited-repository`;
          const matching = scenario === "matching worktree";
          const workspace = matching
            ? repositories.workspace
            : `${repositories.root}/scratch-project`;
          yield* fs.makeDirectory(unrelated);
          if (!matching) yield* fs.makeDirectory(workspace);
          yield* git(unrelated, ["init", "--quiet", "--initial-branch=main"]);
          yield* git(unrelated, ["config", "user.email", "test@example.com"]);
          yield* git(unrelated, ["config", "user.name", "Test"]);
          yield* git(unrelated, [
            "remote",
            "add",
            "unrelated",
            `${repositories.root}/wrong-remote`,
          ]);
          yield* fs.writeFileString(`${unrelated}/wrong.txt`, "unrelated history\n");
          yield* git(unrelated, ["add", "wrong.txt"]);
          yield* git(unrelated, ["commit", "--quiet", "-m", "unrelated history"]);
          yield* fs.writeFileString(`${unrelated}/wrong.txt`, "staged work\n");
          yield* git(unrelated, ["add", "wrong.txt"]);
          yield* fs.writeFileString(`${unrelated}/wrong.txt`, "uncommitted work\n");
          yield* fs.writeFileString(`${unrelated}/.git/FETCH_HEAD`, "unrelated fetch\n");
          const readObjects = Effect.gen(function* () {
            const directory = `${unrelated}/.git/objects`;
            const paths = yield* fs.readDirectory(directory, { recursive: true });
            return yield* Effect.forEach(paths.toSorted(), (path) =>
              Effect.gen(function* () {
                const info = yield* fs.stat(`${directory}/${path}`);
                return {
                  path,
                  contents:
                    info.type === "File" ? yield* fs.readFile(`${directory}/${path}`) : null,
                };
              }),
            );
          });
          const before = {
            refs: yield* git(unrelated, ["show-ref"]),
            head: yield* git(unrelated, ["rev-parse", "HEAD"]),
            status: yield* git(unrelated, ["status", "--porcelain"]),
            index: yield* fs.readFile(`${unrelated}/.git/index`),
            fetchHead: yield* fs.readFileString(`${unrelated}/.git/FETCH_HEAD`),
            objects: yield* readObjects,
            worktrees: yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]),
          };
          const stored = yield* Deferred.make<void>();
          const seen = yield* Deferred.make<{
            readonly input: ReviewGuideGenerationInput;
            readonly head: string;
            readonly changed: string;
            readonly upper: string;
          }>();
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const cleanEnv = {
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
            GIT_COMMON_DIR: undefined,
            GIT_INDEX_FILE: undefined,
            GIT_OBJECT_DIRECTORY: undefined,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          };
          const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
            driver.execute({ operation: "test.readCheckout", cwd, args, env: cleanEnv }).pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.orDie,
            );
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              workspace,
              identity: matching ? ACME_APP : null,
              stored,
              lookup: () =>
                matching
                  ? Effect.die("A matching worktree must not need a clone lookup.")
                  : Effect.succeed({
                      provider: SourceControlProviderKind.make("github"),
                      nameWithOwner: "acme/app",
                      url: repositories.remote,
                      sshUrl: repositories.remote,
                    }),
              generate: (input) =>
                Effect.gen(function* () {
                  const head = yield* readCheckout(input.cwd, ["rev-parse", "HEAD"]);
                  const changed = yield* readCheckout(input.cwd, [
                    "diff",
                    "--name-only",
                    `${input.baseCommit}...HEAD`,
                  ]);
                  const upper = yield* readCheckout(input.cwd, [
                    "show",
                    `${repositories.upperSha}:upper.txt`,
                  ]);
                  yield* Deferred.succeed(seen, { input, head, changed, upper });
                  return { stops: [] };
                }),
            }),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          const logger = Logger.make(({ message }) => {
            if (String(message).includes("Review guide generation failed")) {
              Deferred.doneUnsafe(
                stored,
                Effect.die("The isolated review guide failed before it was stored."),
              );
            }
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const inherited = Object.keys(cleanEnv).map(
                (name) => [name, process.env[name]] as const,
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  for (const [name, value] of inherited) {
                    if (value === undefined) delete process.env[name];
                    else process.env[name] = value;
                  }
                }),
              );
              process.env.GIT_DIR = `${unrelated}/.git`;
              process.env.GIT_WORK_TREE = unrelated;
              process.env.GIT_COMMON_DIR = `${unrelated}/.git`;
              process.env.GIT_INDEX_FILE = `${unrelated}/.git/index`;
              process.env.GIT_OBJECT_DIRECTORY = `${unrelated}/.git/objects`;
              process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = `${repositories.remote}/.git/objects`;
              yield* service
                .generate(reference)
                .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
              yield* Deferred.await(stored);
            }),
          );
          const observed = yield* Deferred.await(seen);
          assert.strictEqual(observed.head, repositories.headSha);
          assert.strictEqual(observed.changed, "feature.txt");
          assert.strictEqual(observed.input.baseCommit, repositories.lowerSha);
          assert.strictEqual(observed.upper, "upper layer");
          assert.deepStrictEqual(
            observed.input.stack?.map((layer) => layer.headSha),
            [repositories.lowerSha, repositories.headSha, repositories.upperSha, null],
          );
          assert.deepStrictEqual(
            (yield* service.get(reference)).guide?.stops.flatMap((stop) =>
              stop.files.map((file) => file.path),
            ),
            ["feature.txt"],
          );
          assert.strictEqual(yield* git(unrelated, ["show-ref"]), before.refs);
          assert.strictEqual(yield* git(unrelated, ["rev-parse", "HEAD"]), before.head);
          assert.strictEqual(yield* git(unrelated, ["status", "--porcelain"]), before.status);
          assert.deepStrictEqual(yield* fs.readFile(`${unrelated}/.git/index`), before.index);
          assert.deepStrictEqual(yield* readObjects, before.objects);
          assert.strictEqual(
            yield* fs.readFileString(`${unrelated}/.git/FETCH_HEAD`),
            before.fetchHead,
          );
          assert.strictEqual(
            yield* fs.readFileString(`${unrelated}/wrong.txt`),
            "uncommitted work\n",
          );
          assert.isFalse(yield* fs.exists(observed.input.cwd));
          assert.strictEqual(
            yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]),
            before.worktrees,
          );
          if (!matching) assert.deepStrictEqual(yield* fs.readDirectory(workspace), []);
        }),
      ),
  );

  it.effect.each(["gitlab", "github"] as const)(
    "fetches %s change request heads and stack layers when the host rejects commit SHA fetches",
    (provider) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const refPrefix = provider === "gitlab" ? "refs/merge-requests" : "refs/pull";
          for (const [number, sha] of [
            [6, repositories.lowerSha],
            [7, repositories.headSha],
            [8, repositories.upperSha],
          ] as const) {
            yield* git(repositories.remote, ["update-ref", `${refPrefix}/${number}/head`, sha]);
          }
          yield* git(repositories.remote, ["update-ref", "-d", "refs/heads/feature"]);
          yield* git(repositories.remote, ["update-ref", "-d", "refs/heads/upper"]);
          const stored = yield* Deferred.make<void>();
          const seen = yield* Deferred.make<{
            readonly input: ReviewGuideGenerationInput;
            readonly head: string;
            readonly changed: string;
            readonly upper: string;
          }>();
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
            driver.execute({ operation: "test.readCheckout", cwd, args }).pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.orDie,
            );
          const rejectShaDriver = GitVcsDriver.GitVcsDriver.of({
            ...driver,
            execute: (input) =>
              input.args[0] === "fetch" && /^[0-9a-f]{40}$/.test(input.args.at(-1) ?? "")
                ? Effect.fail(
                    new GitCommandError({
                      operation: input.operation,
                      command: "git",
                      cwd: input.cwd,
                      detail: "The remote does not accept commit SHA fetches.",
                    }),
                  )
                : driver.execute(input),
          });
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              identity: null,
              detail: { provider: SourceControlProviderKind.make(provider) },
              stored,
              lookup: () =>
                Effect.succeed({
                  provider: SourceControlProviderKind.make(provider),
                  nameWithOwner: "acme/app",
                  url: repositories.remote,
                  sshUrl: repositories.remote,
                }),
              generate: (input) =>
                Effect.gen(function* () {
                  const head = yield* readCheckout(input.cwd, ["rev-parse", "HEAD"]);
                  const changed = yield* readCheckout(input.cwd, [
                    "diff",
                    "--name-only",
                    `${input.baseCommit}...HEAD`,
                  ]);
                  const upper = yield* readCheckout(input.cwd, [
                    "show",
                    `${repositories.upperSha}:upper.txt`,
                  ]);
                  yield* Deferred.succeed(seen, { input, head, changed, upper });
                  return { stops: [] };
                }),
            }).pipe(Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, rejectShaDriver))),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          const logger = Logger.make(({ message }) => {
            if (String(message).includes("Review guide generation failed")) {
              Deferred.doneUnsafe(stored, Effect.die("The change request ref fallback failed."));
            }
          });
          const input = { ...reference, host: `${provider}.com` };
          yield* service
            .generate(input)
            .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
          yield* Deferred.await(stored);
          const observed = yield* Deferred.await(seen);
          assert.strictEqual(observed.head, repositories.headSha);
          assert.strictEqual(observed.changed, "feature.txt");
          assert.strictEqual(observed.input.baseCommit, repositories.lowerSha);
          assert.strictEqual(observed.upper, "upper layer");
          assert.deepStrictEqual(
            observed.input.stack?.map((layer) => layer.headSha),
            [repositories.lowerSha, repositories.headSha, repositories.upperSha, null],
          );
          assert.deepStrictEqual(
            (yield* service.get(input)).guide?.stops.flatMap((stop) =>
              stop.files.map((file) => file.path),
            ),
            ["feature.txt"],
          );
        }),
      ),
  );

  it.effect.each([
    "no checkout",
    "unrelated checkout",
    "unrelated SSH host",
    "same-host SSH",
  ] as const)("writes a linked pull request guide with %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        const workspace = `${repositories.root}/other-project`;
        yield* fs.makeDirectory(workspace);
        let identity: RepositoryIdentity | null = null;
        if (scenario !== "no checkout") {
          yield* git(workspace, ["init", "--quiet", "--initial-branch=main"]);
          yield* git(workspace, ["config", "user.email", "test@example.com"]);
          yield* git(workspace, ["config", "user.name", "Test"]);
          yield* fs.writeFileString(`${workspace}/wrong.txt`, "another repository\n");
          yield* git(workspace, ["add", "wrong.txt"]);
          yield* git(workspace, ["commit", "--quiet", "-m", "unrelated history"]);
          yield* git(workspace, ["remote", "add", "origin", `${repositories.root}/wrong-remote`]);
          yield* fs.writeFileString(`${workspace}/wrong.txt`, "uncommitted work\n");
          const host = scenario === "unrelated SSH host" ? "gitlab.com" : "github.com";
          identity = {
            ...ACME_APP,
            canonicalKey: `${host}/acme/other`,
            displayName: "acme/other",
            name: "other",
            provider: scenario === "unrelated SSH host" ? "gitlab" : "github",
            locator: {
              ...ACME_APP.locator,
              remoteUrl:
                scenario === "unrelated checkout"
                  ? "https://github.com/acme/other.git"
                  : `git@${host}:acme/other.git`,
            },
          };
        }
        const before =
          identity === null
            ? null
            : {
                refs: yield* git(workspace, ["show-ref"]),
                worktrees: yield* git(workspace, ["worktree", "list", "--porcelain"]),
                status: yield* git(workspace, ["status", "--porcelain"]),
              };
        const stored = yield* Deferred.make<void>();
        const seen = yield* Deferred.make<{
          readonly input: ReviewGuideGenerationInput;
          readonly head: string;
          readonly changed: string;
          readonly shallow: string;
          readonly upper: string;
        }>();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
          git(cwd, args).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
            Effect.orDie,
          );
        // Host reads can be routed through a different project; clone lookup must use that cwd.
        const hostWorkspace = `${repositories.root}/host-project`;
        yield* fs.makeDirectory(hostWorkspace);
        const lookupInputs: Array<
          Parameters<NonNullable<Parameters<typeof makeLayer>[0]["lookup"]>>[0]
        > = [];
        const settings = {
          projectSettingsOverrides: {
            [projectId]: { reviewGuideInstructions: "Start with the change's behavior." },
          },
        };
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            workspace,
            identity,
            detail: { workspaceRoot: hostWorkspace },
            stored,
            settings,
            lookup: (input) =>
              Effect.sync(() => {
                lookupInputs.push(input);
                return {
                  provider: SourceControlProviderKind.make("github"),
                  nameWithOwner: "acme/app",
                  url:
                    scenario === "same-host SSH"
                      ? `${repositories.root}/unavailable-https`
                      : repositories.remote,
                  sshUrl:
                    scenario === "same-host SSH"
                      ? repositories.remote
                      : `${repositories.root}/unavailable-ssh`,
                };
              }),
            generate: (input) =>
              Effect.gen(function* () {
                const head = yield* readCheckout(input.cwd, ["rev-parse", "HEAD"]);
                const changed = yield* readCheckout(input.cwd, [
                  "diff",
                  "--name-only",
                  `${input.baseCommit}...HEAD`,
                ]);
                const shallow = yield* readCheckout(input.cwd, [
                  "rev-parse",
                  "--is-shallow-repository",
                ]);
                const upper = yield* readCheckout(input.cwd, [
                  "show",
                  `${repositories.upperSha}:upper.txt`,
                ]);
                yield* Deferred.succeed(seen, { input, head, changed, shallow, upper });
                return { stops: [] };
              }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const started = yield* service.generate(reference);
        assert.isTrue(started.started);
        yield* Deferred.await(stored);
        const inspection = yield* Deferred.await(seen);
        const observed = inspection.input;
        assert.strictEqual(inspection.head, repositories.headSha);
        assert.strictEqual(inspection.changed, "feature.txt");
        assert.strictEqual(inspection.shallow, "false");
        assert.strictEqual(inspection.upper, "upper layer");
        assert.strictEqual(observed.baseCommit, repositories.lowerSha);
        assert.strictEqual(observed.baseBranch, "stack-base");
        assert.strictEqual(observed.instructions, "Start with the change's behavior.");
        assert.deepStrictEqual(
          observed.stack?.map((layer) => layer.headSha),
          [repositories.lowerSha, repositories.headSha, repositories.upperSha, null],
        );
        assert.deepStrictEqual(lookupInputs, [
          {
            provider: SourceControlProviderKind.make("github"),
            repository: "https://github.com/acme/app",
            cwd: hostWorkspace,
          },
        ]);
        const result = yield* service.get(reference);
        assert.strictEqual(result.guide?.headSha, repositories.headSha);
        assert.deepStrictEqual(
          result.guide?.stops.flatMap((stop) => stop.files.map((file) => file.path)),
          ["feature.txt"],
        );
        assert.isFalse(yield* fs.exists(observed.cwd));
        assert.deepStrictEqual(
          yield* fs.readDirectory(`${repositories.root}/server-home/worktrees`),
          [],
        );
        assert.isFalse(yield* fs.exists(`${workspace}/.git/FETCH_HEAD`));
        if (before !== null) {
          assert.strictEqual(yield* git(workspace, ["show-ref"]), before.refs);
          assert.strictEqual(
            yield* git(workspace, ["worktree", "list", "--porcelain"]),
            before.worktrees,
          );
          assert.strictEqual(yield* git(workspace, ["status", "--porcelain"]), before.status);
          assert.strictEqual(
            yield* fs.readFileString(`${workspace}/wrong.txt`),
            "uncommitted work\n",
          );
        } else {
          assert.deepStrictEqual(yield* fs.readDirectory(workspace), []);
        }
      }),
    ),
  );

  it.effect.each([
    {
      provider: "github",
      host: "github.enterprise.example:8443",
      repository: "acme/app",
      selector: "https://github.enterprise.example:8443/acme/app",
    },
    {
      provider: "forgejo",
      host: "code.example.com",
      repository: "acme/app",
      selector: "https://code.example.com/acme/app",
    },
    {
      provider: "gitcafe",
      host: "staging.git.cafe",
      repository: "acme/app",
      selector: "https://staging.git.cafe/acme/app",
    },
    {
      provider: "gitlab",
      host: "gitlab.com",
      repository: "group/nested/app",
      selector: "group/nested/app",
    },
    {
      provider: "azure-devops",
      host: "dev.azure.com",
      repository: "org/project/_git/app",
      selector: "app",
    },
    { provider: "bitbucket", host: "bitbucket.org", repository: "acme/app", selector: "acme/app" },
  ])("resolves the linked repository clone URL for $provider on $host", (target) =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const stored = yield* Deferred.make<void>();
        const lookup =
          yield* Deferred.make<
            Parameters<NonNullable<Parameters<typeof makeLayer>[0]["lookup"]>>[0]
          >();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            identity: null,
            stored,
            detail: {
              provider: SourceControlProviderKind.make(target.provider),
              repository: target.selector,
            },
            lookup: (input) =>
              Deferred.succeed(lookup, input).pipe(
                Effect.as({
                  provider: SourceControlProviderKind.make(target.provider),
                  nameWithOwner: target.repository,
                  url: repositories.remote,
                  sshUrl: `${repositories.root}/unavailable-ssh`,
                }),
              ),
            generate: () => Effect.succeed({ stops: [] }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* service.generate({
          ...reference,
          host: target.host,
          repository: target.repository,
        });
        yield* Deferred.await(stored);
        assert.deepStrictEqual(yield* Deferred.await(lookup), {
          provider: SourceControlProviderKind.make(target.provider),
          repository: target.selector,
          cwd: repositories.workspace,
        });
      }),
    ),
  );

  it.effect.each(["failure", "interruption"] as const)(
    "removes the private repository after %s",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const fs = yield* FileSystem.FileSystem;
          const seen = yield* Deferred.make<string>();
          const failed = yield* Deferred.make<void>();
          const stored = yield* Deferred.make<void>();
          const serviceScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
          const logger = Logger.make(({ message }) => {
            if (String(message).includes("Review guide generation failed"))
              Deferred.doneUnsafe(failed, Effect.void);
          });
          const context = yield* Layer.buildWithScope(
            makeLayer({
              ...repositories,
              identity: null,
              stored,
              lookup: () =>
                Effect.succeed({
                  provider: SourceControlProviderKind.make("github"),
                  nameWithOwner: "acme/app",
                  url: repositories.remote,
                  sshUrl: repositories.remote,
                }),
              generate: (input) =>
                Deferred.succeed(seen, input.cwd).pipe(
                  Effect.andThen(
                    outcome === "failure"
                      ? Effect.fail(
                          new TextGenerationError({
                            operation: "generateReviewGuide",
                            detail: "Test model failed.",
                          }),
                        )
                      : Effect.never,
                  ),
                ),
            }).pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
            serviceScope,
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          const previous = yield* service.get(reference);
          yield* service
            .generate(reference)
            .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
          const checkout = yield* Deferred.await(seen);
          if (outcome === "failure") yield* Deferred.await(failed);
          else assert.isTrue(yield* fs.exists(`${checkout}/.git`));
          yield* Scope.close(serviceScope, Exit.void);
          assert.isFalse(yield* fs.exists(checkout));
          assert.deepStrictEqual(
            yield* fs.readDirectory(`${repositories.root}/server-home/worktrees`),
            [],
          );
          assert.isFalse(yield* Deferred.isDone(stored));
          assert.deepStrictEqual((yield* service.get(reference)).guide, previous.guide);
        }),
      ),
  );
});
