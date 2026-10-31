import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
import {
  ProjectId,
  GitCommandError,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestStack,
  type PullRequestRef,
} from "@t3tools/contracts";

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
  return { root, remote, workspace, headSha, lowerSha, upperSha };
});

const detail = (workspaceRoot: string, headSha: string): PullRequestDetail =>
  ({
    provider: "github",
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
  readonly remote: string;
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
            repositoryIdentity: {
              ...(input.identity ?? ACME_APP),
              locator: { ...ACME_APP.locator, remoteUrl: input.remote },
            },
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

// A run forks into the service's scope, so a test learns it settled when the run's `write` span
// ends; the run records its outcome synchronously right after.
const watchRuns = Effect.gen(function* () {
  const ended = yield* Queue.unbounded<void>();
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      if (options.name !== "PullRequestReviewGuideService.write") return span;
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        Queue.offerUnsafe(ended, undefined);
      };
      return span;
    },
  });
  return {
    generate: (
      service: PullRequestReviewGuideService.PullRequestReviewGuideService["Service"],
      input: PullRequestRef,
    ) => service.generate(input).pipe(Effect.withTracer(tracer)),
    settled: (
      service: PullRequestReviewGuideService.PullRequestReviewGuideService["Service"],
      input: PullRequestRef,
    ) => Queue.take(ended).pipe(Effect.andThen(service.get(input))),
  };
});

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
    const runs = yield* watchRuns;
    yield* runs.generate(service, guideReference);
    return {
      repositories,
      reportedHead,
      service,
      reference: guideReference,
      stored,
      fetchedRefs,
      observed,
      settled: runs.settled(service, guideReference),
    };
  });

it.layer(layerBase, { excludeTestServices: true })("PullRequestReviewGuideService", (it) => {
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
      expected: ["local objects:", "the commit:", "branch feature:", "refs/pull/7/head:"],
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
        const result = yield* run.settled;
        assert.isFalse(yield* Deferred.isDone(run.stored), "a guide was written");
        assert.strictEqual(result.run?._tag, "Failed");
        const detail = result.run?._tag === "Failed" ? result.run.detail : "";
        for (const part of expected) assert.include(detail, part);
        // Only the host's own head ref is tried.
        assert.notInclude(detail, "refs/merge-requests/");
        assert.deepStrictEqual(run.observed, []);
        assert.isFalse(run.fetchedRefs.some((ref) => ref.startsWith("-")));
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(`${run.repositories.root}/injected`));
      }),
    ),
  );

  it.effect("measures only the PR change using the renamed verified remote's fetch URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fork = `${repositories.root}/fork`;
        yield* git(repositories.root, ["clone", "--quiet", repositories.remote, fork]);
        yield* git(fork, ["branch", "stack-base", "main~1"]);
        // The cached identity still names origin, which now belongs to the stale fork.
        yield* git(repositories.workspace, ["remote", "rename", "origin", "upstream"]);
        yield* git(repositories.workspace, ["remote", "add", "origin", fork]);
        yield* git(repositories.workspace, [
          "config",
          `url.${repositories.remote}.insteadOf`,
          "review-upstream:",
        ]);
        yield* git(repositories.workspace, ["remote", "set-url", "upstream", "review-upstream:"]);
        const changed = yield* Deferred.make<string>();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: (input) =>
              git(input.cwd, ["diff", "--name-only", `${input.baseCommit}...HEAD`]).pipe(
                Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
                Effect.orDie,
                Effect.flatMap((names) => Deferred.succeed(changed, names)),
                Effect.as({ stops: [] }),
              ),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* service.generate(reference);
        assert.strictEqual(yield* Deferred.await(changed), "feature.txt");
        yield* Deferred.await(stored);
        const result = yield* service.get(reference);
        assert.strictEqual(result.guide?.headSha, repositories.headSha);
        assert.deepStrictEqual(result.guide?.stops[0]?.files, [{ path: "feature.txt" }]);
      }),
    ),
  );

  it.effect("keeps excerpts of source lines a configured diff driver would convert away", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${repositories.workspace}/.git/info/attributes`,
          "feature.txt diff=blank\n",
        );
        yield* git(repositories.workspace, ["config", "diff.blank.textconv", "true"]);
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: () =>
              Effect.succeed({
                stops: [
                  {
                    title: "The feature",
                    summary: "The change.",
                    attention: null,
                    excerpts: [{ path: "feature.txt", side: "new", start: 1, end: 3, caption: "" }],
                    files: [],
                    notes: [],
                    questions: [],
                  },
                ],
              }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* service.generate(reference);
        yield* Deferred.await(stored);
        const result = yield* service.get(reference);
        assert.deepStrictEqual(result.guide?.stops[0]?.excerpts, [
          { path: "feature.txt", side: "new", start: 1, end: 3, caption: "" },
        ]);
      }),
    ),
  );

  it.effect("refuses generation when the verified remote disappeared despite a usable origin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fork = `${repositories.root}/fork`;
        yield* git(repositories.root, ["clone", "--quiet", repositories.remote, fork]);
        yield* git(fork, ["branch", "stack-base", repositories.lowerSha]);
        yield* git(repositories.workspace, ["remote", "set-url", "origin", fork]);
        const started = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const stored = yield* Deferred.make<void>();
        const generated = yield* Ref.make(false);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: () => Ref.set(generated, true).pipe(Effect.as({ stops: [] })),
          }).pipe(
            Layer.provide(
              Layer.succeed(GitVcsDriver.GitVcsDriver, {
                ...driver,
                execute: (call) =>
                  Effect.withFiber((fiber) =>
                    Deferred.succeed(started, fiber).pipe(Effect.andThen(driver.execute(call))),
                  ),
              }),
            ),
          ),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const before = yield* service.get(reference);
        yield* service.generate(reference);
        // Join the background run so its failure is visible without polling service state.
        yield* Fiber.await(yield* Deferred.await(started));
        const result = yield* service.get(reference);
        assert.strictEqual(result.run?._tag, "Failed");
        assert.include(
          result.run?._tag === "Failed" ? result.run.detail : "",
          "no longer has a remote for the pull request's repository",
        );
        assert.deepStrictEqual(result.guide, before.guide);
        assert.isFalse(yield* Deferred.isDone(stored));
        assert.isFalse(yield* Ref.get(generated));
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
