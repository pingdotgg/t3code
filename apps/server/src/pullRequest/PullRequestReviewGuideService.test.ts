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
