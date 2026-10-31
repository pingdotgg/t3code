import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
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
const ACME_APP = {
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/app.git",
  },
  provider: SourceControlProviderKind.make("github"),
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
    repository: "acme/app",
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
            repositoryIdentity:
              input.identity === undefined
                ? { ...ACME_APP, locator: { ...ACME_APP.locator, remoteUrl: input.remote } }
                : input.identity,
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
          locator: { ...ACME_APP.locator, remoteUrl: repositories.remote },
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
                  : git(workspace, [
                      "-c",
                      "tag.gpgSign=false",
                      shadow,
                      repositories.headSha.slice(0, 12),
                      "HEAD",
                    ]),
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

          const runs = yield* watchRuns;
          yield* runs.generate(service, reference);
          yield* Deferred.await(oldStarted);
          yield* Ref.set(currentHead, repositories.upperSha);
          const second = yield* runs.generate(service, reference);
          assert.strictEqual(second.run?._tag, "Running");
          assert.strictEqual(second.run?.headSha, repositories.upperSha);
          const settled = yield* runs.settled(service, reference);
          assert.strictEqual(settled.guide?.headSha, repositories.upperSha);

          yield* Deferred.succeed(releaseOld, undefined);
          const after = yield* runs.settled(service, reference);
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
              identity: matching
                ? { ...ACME_APP, locator: { ...ACME_APP.locator, remoteUrl: repositories.remote } }
                : null,
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
            provider: SourceControlProviderKind.make(
              scenario === "unrelated SSH host" ? "gitlab" : "github",
            ),
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
