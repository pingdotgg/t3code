import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import {
  ProjectId,
  GitCommandError,
  TextGenerationError,
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

const makeEvidenceRepositories = Effect.gen(function* () {
  const repositories = yield* makeRepositories;
  const fs = yield* FileSystem.FileSystem;
  const { remote, workspace } = repositories;
  yield* git(remote, ["checkout", "--quiet", "feature"]);
  yield* git(remote, ["reset", "--hard", repositories.lowerSha]);
  yield* fs.writeFileString(`${remote}/deleted.ts`, "old entry\nold implementation\nold export\n");
  yield* fs.writeFileString(
    `${remote}/deleted-long.txt`,
    `${"x".repeat(32_767)}GIF89a${"readable source text".repeat(32)}\n`,
  );
  yield* fs.writeFileString(
    `${remote}/deleted-image.txt`,
    `${"x".repeat(32_767 - Buffer.byteLength("T3 review guide evidence\n"))}GIF89a${"readable source text".repeat(32)}\n`,
  );
  yield* fs.writeFileString(`${remote}/rename.txt`, "rename me\n");
  yield* git(remote, ["add", "."]);
  yield* git(remote, ["commit", "--quiet", "-m", "legacy entry point"]);
  const lowerSha = yield* git(remote, ["rev-parse", "HEAD"]);
  yield* git(remote, ["branch", "-f", "stack-base", lowerSha]);
  yield* fs.remove(`${remote}/deleted.ts`);
  yield* fs.remove(`${remote}/deleted-long.txt`);
  yield* fs.remove(`${remote}/deleted-image.txt`);
  yield* fs.rename(`${remote}/rename.txt`, `${remote}/renamed.txt`);
  yield* fs.writeFileString(
    `${remote}/added.ts`,
    `export const feature = true;\n${"😀Ω".repeat(12_000)}\n` +
      Array.from({ length: 2_300 }, (_, index) => `// ${index}`).join("\n") +
      "\n",
  );
  yield* fs.writeFileString(`${remote}/empty.txt`, "");
  const unusualPath = 'odd\t"Ω\nname.txt';
  yield* fs.writeFileString(`${remote}/${unusualPath}`, "unusual path\n");
  yield* fs.writeFile(`${remote}/binary.bin`, new Uint8Array([0, 1, 2]));
  yield* git(remote, ["add", "-A"]);
  yield* git(remote, ["commit", "--quiet", "-m", "replace legacy entry point"]);
  const headSha = yield* git(remote, ["rev-parse", "HEAD"]);
  yield* git(remote, ["checkout", "--quiet", "-B", "upper"]);
  yield* fs.writeFileString(
    `${remote}/consumer.ts`,
    'import { feature } from "./added";\nuse(feature);\n',
  );
  yield* git(remote, ["add", "consumer.ts"]);
  yield* git(remote, ["commit", "--quiet", "-m", "wire the upper consumer"]);
  const upperSha = yield* git(remote, ["rev-parse", "HEAD"]);
  // Both configured helpers must be bypassed by fixed evidence commands.
  yield* git(workspace, ["config", "diff.external", "false"]);
  yield* fs.writeFileString(`${repositories.root}/attributes`, "*.ts diff=fixture\n");
  yield* git(workspace, ["config", "core.attributesFile", `${repositories.root}/attributes`]);
  yield* git(workspace, ["config", "diff.fixture.textconv", "false"]);
  yield* git(workspace, ["config", "diff.srcPrefix", "wrong/"]);
  yield* git(workspace, ["config", "color.ui", "always"]);
  return { ...repositories, headSha, lowerSha, upperSha, unusualPath };
});

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Number,
      baseCommit: Schema.String,
      headCommit: Schema.String,
      stack: Schema.Array(
        Schema.Struct({ number: Schema.Number, headSha: Schema.NullOr(Schema.String) }),
      ),
      streams: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          headCommit: Schema.optional(Schema.String),
          bytes: Schema.Number,
          chunks: Schema.Array(
            Schema.Struct({
              file: Schema.String,
              offset: Schema.Number,
              payloadOffset: Schema.Number,
              bytes: Schema.Number,
              startsMidLine: Schema.Boolean,
              endsMidLine: Schema.Boolean,
            }),
          ),
        }),
      ),
    }),
  ),
);

const readEvidenceStreams = Effect.fn("test.readEvidenceStreams")(function* (manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* decodeManifest(yield* fs.readFileString(manifestPath));
  const directory = manifestPath.slice(0, -"manifest.json".length);
  const streams = new Map<string, string>();
  for (const stream of manifest.streams) {
    const chunks = yield* Effect.forEach(stream.chunks, (chunk) =>
      fs
        .readFile(`${directory}${chunk.file}`)
        .pipe(
          Effect.map((bytes) =>
            bytes.subarray(chunk.payloadOffset, chunk.payloadOffset + chunk.bytes),
          ),
        ),
    );
    streams.set(
      `${stream.kind}:${stream.headCommit ?? ""}`,
      Buffer.concat(chunks).toString("utf8"),
    );
  }
  return streams;
});

const assertCleaned = Effect.fn("test.assertReviewGuideCleaned")(function* (
  workspace: string,
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const path of paths) assert.isFalse(yield* fs.exists(path), path);
  assert.equal(yield* git(workspace, ["for-each-ref", "refs/t3/review-guide"]), "");
  const worktrees = yield* git(workspace, ["worktree", "list", "--porcelain"]);
  for (const path of paths) assert.notInclude(worktrees, path);
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
  readonly stack?: PullRequestStack;
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
        stack: () => Effect.succeed(input.stack ?? stack(input)),
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
  it.effect(
    "a replaced run cannot overwrite the current head's guide and both bundles are removed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const currentHead = yield* Ref.make(repositories.headSha);
          const stored = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const paths: Array<string> = [];
          const runs = yield* watchRuns;
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              currentHead,
              stored,
              generate: (input) =>
                Effect.gen(function* () {
                  assert(input.evidence);
                  const evidence = yield* input.evidence;
                  paths.push(input.cwd, evidence.manifestPath);
                  if (evidence.headCommit === repositories.headSha) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                  return { stops: [] };
                }),
            }),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          yield* runs.generate(service, reference);
          yield* Deferred.await(started);
          yield* Ref.set(currentHead, repositories.upperSha);
          yield* runs.generate(service, reference);
          yield* runs.settled(service, reference);
          yield* Deferred.await(stored);
          yield* Deferred.succeed(release, undefined);
          const result = yield* runs.settled(service, reference);
          assert.equal(result.run, null);
          assert.equal(result.guide?.headSha, repositories.upperSha);
          assert.equal(paths.length, 4);
          yield* assertCleaned(repositories.workspace, paths);
        }),
      ),
  );
  it.effect.each([
    "change",
    "change-size",
    "git",
    "history",
    "missing",
    "size",
    "framing-size",
    "directory",
    "write",
    "manifest",
    "model",
  ] as const)(
    "cleans the checkout and evidence after a %s failure without publishing an incomplete bundle",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const fs = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const missingBlob = yield* git(repositories.workspace, [
            "rev-parse",
            `${repositories.upperSha}:upper.txt`,
          ]);
          if (failure === "missing") {
            yield* git(repositories.workspace, ["config", "remote.origin.promisor", "true"]);
          }
          const stored = yield* Deferred.make<void>();
          const runs = yield* watchRuns;
          const paths: Array<string> = [];
          let descriptorReturned = false;
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              stored,
              generate: (input) =>
                Effect.gen(function* () {
                  paths.push(input.cwd, `${input.cwd}/../evidence`);
                  assert(input.evidence);
                  const descriptor = yield* input.evidence;
                  descriptorReturned = true;
                  assert.isTrue(yield* fs.exists(descriptor.manifestPath));
                  return yield* new TextGenerationError({
                    operation: "generateReviewGuide",
                    detail: "Fixture model failed",
                  });
                }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie),
            }).pipe(
              Layer.provide(
                Layer.succeed(GitVcsDriver.GitVcsDriver, {
                  ...driver,
                  execute: (call) =>
                    Effect.gen(function* () {
                      if (
                        call.operation === "PullRequestReviewGuideService.readChange" &&
                        (failure === "change" || failure === "change-size")
                      ) {
                        return yield* new GitCommandError({
                          operation: call.operation,
                          command: "git",
                          cwd: call.cwd,
                          detail: "Fixture main change failed",
                          ...(failure === "change-size"
                            ? { outputLength: 64 * 1024 * 1024 + 1 }
                            : {}),
                        });
                      }
                      if (call.operation === "PullRequestReviewGuideService.readEvidence") {
                        assert.isFalse(
                          yield* fs
                            .exists(`${call.cwd}/../evidence/manifest.json`)
                            .pipe(Effect.orDie),
                        );
                        if (
                          failure === "git" ||
                          (failure === "history" && call.args.includes("log"))
                        )
                          return yield* new GitCommandError({
                            operation: call.operation,
                            command: "git",
                            cwd: call.cwd,
                            detail: "Missing local object",
                          });
                        if (
                          failure === "missing" &&
                          call.args.some((arg) => arg.includes(repositories.upperSha))
                        ) {
                          yield* fs
                            .remove(
                              `${repositories.workspace}/.git/objects/${missingBlob.slice(0, 2)}/${missingBlob.slice(2)}`,
                            )
                            .pipe(Effect.orDie);
                          yield* fs
                            .remove(
                              `${repositories.remote}/.git/objects/${missingBlob.slice(0, 2)}/${missingBlob.slice(2)}`,
                            )
                            .pipe(Effect.orDie);
                        }
                        if (
                          failure === "size" &&
                          call.args.some((arg) => arg.includes(repositories.upperSha))
                        ) {
                          return yield* new GitCommandError({
                            operation: call.operation,
                            command: "git",
                            cwd: call.cwd,
                            detail: "Fixture Git output exceeded its byte limit",
                            outputLength: 64 * 1024 * 1024 + 1,
                          });
                        }
                        if (
                          failure === "framing-size" &&
                          call.args.some((arg) => arg.includes(repositories.upperSha))
                        ) {
                          const result = yield* driver.execute(call);
                          // The 430 KiB margin covers the index, but cannot also cover chunk preambles.
                          return { ...result, stdout: "x".repeat(64 * 1024 * 1024 - 430 * 1024) };
                        }
                      }
                      return yield* driver.execute(call);
                    }),
                }),
              ),
              Layer.provide(
                Layer.succeed(FileSystem.FileSystem, {
                  ...fs,
                  makeDirectory: (path, options) =>
                    failure === "directory" && path.endsWith("/evidence")
                      ? Effect.fail(
                          PlatformError.systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "makeDirectory",
                            pathOrDescriptor: path,
                          }),
                        )
                      : fs.makeDirectory(path, options),
                  writeFile: (path, bytes, options) =>
                    failure === "write" && path.includes("/evidence/")
                      ? Effect.fail(
                          PlatformError.systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "writeFile",
                            pathOrDescriptor: path,
                          }),
                        )
                      : fs.writeFile(path, bytes, options),
                  writeFileString: (path, text, options) =>
                    failure === "manifest" && path.endsWith("/evidence/manifest.json")
                      ? Effect.fail(
                          PlatformError.systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "writeFileString",
                            pathOrDescriptor: path,
                          }),
                        )
                      : fs.writeFileString(path, text, options),
                }),
              ),
            ),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          const storedGuide = (yield* service.get(reference)).guide;
          yield* runs.generate(service, reference);
          const result = yield* runs.settled(service, reference);
          assert.equal(result.run?._tag, "Failed");
          assert.deepEqual(result.guide, storedGuide);
          assert.isFalse(yield* Deferred.isDone(stored));
          assert.equal(descriptorReturned, failure === "model");
          if (failure === "missing") {
            assert.isFalse(
              yield* fs.exists(
                `${repositories.workspace}/.git/objects/${missingBlob.slice(0, 2)}/${missingBlob.slice(2)}`,
              ),
            );
            assert.isFalse(
              yield* fs.exists(
                `${repositories.remote}/.git/objects/${missingBlob.slice(0, 2)}/${missingBlob.slice(2)}`,
              ),
            );
          }
          const expectedDetail = {
            change: "Could not read the main change for the review guide.",
            "change-size": "Complete review guide evidence exceeds the 64 MiB limit.",
            git: "Could not read review guide stat evidence.",
            history: "Could not read review guide history evidence.",
            missing: `Could not read review guide stackComparison evidence for pinned stack head ${repositories.upperSha}.`,
            size: "Complete review guide evidence exceeds the 64 MiB limit.",
            "framing-size": "Complete review guide evidence exceeds the 64 MiB limit.",
            directory: "Could not create the review guide evidence directory.",
            write: "Could not write review guide changedPaths evidence chunk 0-0.txt.",
            manifest: "Could not write the review guide evidence manifest.json.",
            model: "Fixture model failed",
          }[failure];
          assert.equal(result.run?._tag === "Failed" ? result.run.detail : "", expectedDetail);
          yield* assertCleaned(repositories.workspace, paths);
        }),
      ),
  );
  it.effect(
    "shares lossless completed Git evidence with generation and normalizes the same change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeEvidenceRepositories;
          const fs = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const stored = yield* Deferred.make<void>();
          const runs = yield* watchRuns;
          const calls: Array<GitVcsDriver.ExecuteGitInput> = [];
          const paths: Array<string> = [];
          let sawSplitLine = false;
          let sawImageLikeContinuation = false;
          let sawPageableChunk = false;
          const raw = (cwd: string, args: ReadonlyArray<string>) =>
            driver
              .execute({
                operation: "test.evidence",
                cwd,
                args,
                maxOutputBytes: 1024 * 1024,
              })
              .pipe(Effect.map((result) => result.stdout));
          const layers = stack(repositories);
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              headSha: repositories.headSha.slice(0, 12),
              stack: {
                ...layers,
                layers: [
                  ...layers.layers,
                  {
                    number: 10,
                    title: "Same head",
                    headSha: repositories.upperSha,
                    headBranch: "upper",
                    state: "open",
                  },
                ],
              },
              stored,
              generate: (input) =>
                Effect.gen(function* () {
                  assert(input.evidence);
                  const [evidence, same] = yield* Effect.all([input.evidence, input.evidence], {
                    concurrency: "unbounded",
                  });
                  assert.strictEqual(evidence, same);
                  paths.push(input.cwd, evidence.manifestPath);
                  assert.equal(evidence.headCommit, repositories.headSha);
                  assert.equal(input.baseCommit, repositories.lowerSha);
                  assert.equal(
                    input.stack?.find((layer) => layer.number === 7)?.headSha,
                    repositories.headSha,
                  );
                  const manifestText = yield* fs.readFileString(evidence.manifestPath);
                  for (const line of manifestText.split("\n"))
                    assert.isBelow(Buffer.byteLength(line), 32 * 1024);
                  const manifest = yield* decodeManifest(manifestText);
                  assert.equal(manifest.baseCommit, repositories.lowerSha);
                  assert.equal(manifest.headCommit, repositories.headSha);
                  assert.equal(manifest.stack.find((layer) => layer.number === 9)?.headSha, null);
                  const reconstructed = new Map<string, string>();
                  for (const stream of manifest.streams) {
                    const chunks: Array<Uint8Array> = [];
                    let offset = 0;
                    for (const chunk of stream.chunks) {
                      assert.match(chunk.file, /^\d+-\d+\.txt$/);
                      const bytes = yield* fs.readFile(
                        `${evidence.manifestPath.slice(0, -"manifest.json".length)}${chunk.file}`,
                      );
                      assert.isAtMost(bytes.length, 32 * 1024);
                      assert.isAbove(chunk.payloadOffset, 0);
                      assert.equal(
                        new TextDecoder("utf8", { fatal: true }).decode(
                          bytes.subarray(0, chunk.payloadOffset),
                        ),
                        "T3 review guide evidence\n",
                      );
                      const payload = bytes.subarray(chunk.payloadOffset);
                      sawImageLikeContinuation ||=
                        chunk.startsMidLine &&
                        new TextDecoder("utf8", { fatal: true })
                          .decode(payload)
                          .startsWith("GIF89a");
                      assert.equal(chunk.offset, offset);
                      assert.equal(chunk.bytes, payload.length);
                      const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
                      sawPageableChunk ||= text.split("\n").length > 2_000;
                      sawSplitLine ||= chunk.startsMidLine || chunk.endsMidLine;
                      chunks.push(payload);
                      offset += payload.length;
                    }
                    assert.equal(offset, stream.bytes);
                    const combined = Buffer.concat(chunks);
                    for (const chunk of stream.chunks) {
                      assert.equal(
                        chunk.startsMidLine,
                        chunk.offset > 0 && combined[chunk.offset - 1] !== 10,
                      );
                      const end = chunk.offset + chunk.bytes;
                      assert.equal(
                        chunk.endsMidLine,
                        end < combined.length && combined[end - 1] !== 10,
                      );
                    }
                    reconstructed.set(
                      `${stream.kind}:${stream.headCommit ?? ""}`,
                      combined.toString("utf8"),
                    );
                  }
                  const diff = [
                    "--no-pager",
                    "-c",
                    "core.quotePath=false",
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--src-prefix=a/",
                    "--dst-prefix=b/",
                  ];
                  const range = `${repositories.lowerSha}...${repositories.headSha}`;
                  const names = yield* raw(input.cwd, [...diff, "--name-only", "-z", range, "--"]);
                  const decodePath = Schema.decodeUnknownEffect(
                    Schema.fromJsonString(Schema.String),
                  );
                  assert.deepEqual(
                    yield* Effect.forEach(
                      reconstructed.get("changedPaths:")?.trimEnd().split("\n") ?? [],
                      (path) => decodePath(path),
                    ),
                    names.split("\0").filter(Boolean),
                  );
                  assert.include(
                    reconstructed.get("changedPaths:") ?? "",
                    JSON.stringify(repositories.unusualPath),
                  );
                  assert.equal(
                    reconstructed.get("patch:"),
                    yield* raw(input.cwd, [...diff, "--unified=0", range, "--"]),
                  );
                  assert.include(reconstructed.get("patch:") ?? "", "-old implementation");
                  assert.include(
                    reconstructed.get("patch:") ?? "",
                    `-${"x".repeat(32_767)}GIF89a${"readable source text".repeat(32)}\n`,
                  );
                  assert.isFalse(yield* fs.exists(`${input.cwd}/deleted-long.txt`));
                  assert.equal(
                    reconstructed.get("stat:"),
                    yield* raw(input.cwd, [...diff, "--stat", range, "--"]),
                  );
                  assert.equal(
                    reconstructed.get("history:"),
                    yield* raw(input.cwd, [
                      "--no-pager",
                      "log",
                      "--no-show-signature",
                      "--no-color",
                      "--format=%h %s",
                      `${repositories.lowerSha}..${repositories.headSha}`,
                      "--",
                    ]),
                  );
                  for (const head of [repositories.lowerSha, repositories.upperSha]) {
                    assert.equal(
                      reconstructed.get(`stackComparison:${head}`),
                      yield* raw(input.cwd, [...diff, `${repositories.headSha}...${head}`, "--"]),
                    );
                  }
                  assert.equal(
                    manifest.streams.filter((stream) => stream.kind === "stackComparison").length,
                    2,
                  );
                  assert.include(
                    reconstructed.get(`stackComparison:${repositories.upperSha}`) ?? "",
                    "+use(feature)",
                  );
                  assert.isFalse(yield* fs.exists(`${input.cwd}/consumer.ts`));
                  return {
                    stops: [
                      {
                        title: "Replace the legacy entry point",
                        attention: null,
                        summary:
                          "The feature replaces the legacy implementation and is consumed by #8.",
                        excerpts: [
                          {
                            path: "added.ts",
                            side: "new" as const,
                            start: 1,
                            end: 3,
                            caption: "New implementation",
                          },
                          {
                            path: "deleted.ts",
                            side: "old" as const,
                            start: 1,
                            end: 3,
                            caption: "Legacy implementation",
                          },
                        ],
                        files: names
                          .split("\0")
                          .filter(
                            (path) => path !== "" && path !== "added.ts" && path !== "deleted.ts",
                          )
                          .map((path) => ({ path, note: "" })),
                        notes: [],
                        questions: [],
                      },
                    ],
                  };
                }).pipe(Effect.orDie),
            }).pipe(
              Layer.provide(
                Layer.succeed(GitVcsDriver.GitVcsDriver, {
                  ...driver,
                  execute: (call) =>
                    Effect.suspend(() => {
                      calls.push(call);
                      return driver.execute(call);
                    }),
                }),
              ),
            ),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          yield* runs.generate(service, reference);
          const result = yield* runs.settled(service, reference);
          assert.equal(result.run, null);
          assert.isTrue(yield* Deferred.isDone(stored));
          assert.equal(result.guide?.stops.length, 1);
          assert.deepEqual(
            result.guide?.stops[0]?.excerpts.map(({ path, side, start, end }) => ({
              path,
              side,
              start,
              end,
            })),
            [
              { path: "added.ts", side: "new", start: 1, end: 3 },
              { path: "deleted.ts", side: "old", start: 1, end: 3 },
            ],
          );
          assert.isTrue(sawSplitLine);
          assert.isTrue(sawImageLikeContinuation);
          assert.isTrue(sawPageableChunk);
          assert.equal(
            calls.filter((call) => call.operation === "PullRequestReviewGuideService.readChange")
              .length,
            2,
          );
          assert.equal(
            calls.filter((call) => call.operation === "PullRequestReviewGuideService.readEvidence")
              .length,
            4,
          );
          yield* assertCleaned(repositories.workspace, paths);
        }),
      ),
  );

  it.effect(
    "keeps stale merged and closed stack changes separate from main drift and coverage",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const original = yield* makeRepositories;
          const fs = yield* FileSystem.FileSystem;
          const { remote } = original;
          const staleBase = yield* git(remote, ["rev-parse", "main~1"]);
          const neighbors = yield* Effect.forEach(["merged", "closed"] as const, (state) =>
            Effect.gen(function* () {
              yield* git(remote, ["checkout", "--quiet", "-b", state, staleBase]);
              yield* fs.writeFileString(`${remote}/${state}.txt`, `${state} contribution\n`);
              yield* git(remote, ["add", "."]);
              yield* git(remote, ["commit", "--quiet", "-m", `${state} neighbor`]);
              return {
                number: state === "merged" ? 4 : 5,
                title: state,
                headBranch: state,
                headSha: yield* git(remote, ["rev-parse", "HEAD"]),
                state,
              };
            }),
          );
          yield* git(remote, ["checkout", "--quiet", "-B", "stack-base", "main"]);
          const lowerSha = yield* git(remote, ["rev-parse", "HEAD"]);
          yield* git(remote, ["checkout", "--quiet", "-B", "feature"]);
          yield* fs.writeFileString(`${remote}/feature.txt`, "current implementation\n");
          yield* git(remote, ["add", "."]);
          yield* git(remote, ["commit", "--quiet", "-m", "Current change"]);
          const headSha = yield* git(remote, ["rev-parse", "HEAD"]);
          yield* git(remote, ["checkout", "--quiet", "-B", "upper"]);
          yield* fs.writeFileString(`${remote}/consumer.ts`, 'import "./feature.txt";\n');
          yield* git(remote, ["add", "."]);
          yield* git(remote, ["commit", "--quiet", "-m", "Upper consumer"]);
          const upperSha = yield* git(remote, ["rev-parse", "HEAD"]);
          const repositories = { ...original, lowerSha, headSha, upperSha };
          const layers = stack(repositories);
          const stored = yield* Deferred.make<void>();
          const runs = yield* watchRuns;
          const paths: Array<string> = [];
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              stack: { ...layers, layers: [...neighbors, ...layers.layers] },
              stored,
              generate: (input) =>
                Effect.gen(function* () {
                  assert(input.evidence);
                  const evidence = yield* input.evidence;
                  paths.push(input.cwd, evidence.manifestPath);
                  const streams = yield* readEvidenceStreams(evidence.manifestPath);
                  assert.equal(streams.get("changedPaths:"), '"feature.txt"\n');
                  for (const neighbor of neighbors) {
                    const comparison = streams.get(`stackComparison:${neighbor.headSha}`) ?? "";
                    assert.include(comparison, `+${neighbor.state} contribution`);
                    assert.notInclude(comparison, "unrelated.txt");
                    assert.notInclude(comparison, "feature.txt");
                  }
                  assert.equal(streams.get(`stackComparison:${lowerSha}`), "");
                  assert.include(
                    streams.get(`stackComparison:${upperSha}`) ?? "",
                    '+import "./feature.txt"',
                  );
                  assert.isFalse(yield* fs.exists(`${input.cwd}/consumer.ts`));
                  return {
                    stops: [
                      {
                        title: "Current feature",
                        summary: "The upper layer consumes the feature.",
                        attention: null,
                        excerpts: [],
                        files: ["feature.txt", "merged.txt", "closed.txt", "consumer.ts"].map(
                          (path) => ({ path, note: "" }),
                        ),
                        notes: [],
                        questions: [],
                      },
                    ],
                  };
                }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie),
            }),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          yield* runs.generate(service, reference);
          const result = yield* runs.settled(service, reference);
          assert.equal(result.run, null);
          assert.isTrue(yield* Deferred.isDone(stored));
          assert.deepEqual(result.guide?.stops[0]?.files, [{ path: "feature.txt" }]);
          yield* assertCleaned(original.workspace, paths);
        }),
      ),
  );

  it.effect("fetches missing upper-only promisor blobs and stores the complete guide", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const original = yield* makeEvidenceRepositories;
        const fs = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { remote } = original;
        const workspace = `${original.root}/partial-workspace`;
        yield* git(remote, ["config", "uploadpack.allowFilter", "true"]);
        yield* git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
        yield* git(original.root, [
          "clone",
          "--quiet",
          "--no-local",
          "--filter=blob:none",
          "--branch",
          "main",
          remote,
          workspace,
        ]);
        const missingBlob = yield* git(remote, ["rev-parse", `${original.upperSha}:consumer.ts`]);
        const localObjects = git(workspace, ["cat-file", "--batch-check", "--batch-all-objects"]);
        assert.notInclude(yield* localObjects, missingBlob);
        const stored = yield* Deferred.make<void>();
        const runs = yield* watchRuns;
        const paths: Array<string> = [];
        const context = yield* Layer.build(
          makeLayer({
            ...original,
            workspace,
            stored,
            generate: (input) =>
              Effect.gen(function* () {
                assert(input.evidence);
                assert.notInclude(yield* localObjects, missingBlob);
                const [evidence, cached] = yield* Effect.all([input.evidence, input.evidence], {
                  concurrency: "unbounded",
                });
                assert.strictEqual(evidence, cached);
                paths.push(input.cwd, evidence.manifestPath);
                const streams = yield* readEvidenceStreams(evidence.manifestPath);
                assert.include(
                  streams.get(`stackComparison:${original.upperSha}`) ?? "",
                  "+use(feature)",
                );
                assert.notInclude(streams.get("changedPaths:") ?? "", "consumer.ts");
                assert.include(yield* localObjects, missingBlob);
                return { stops: [] };
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
                Effect.orDie,
              ),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* runs.generate(service, reference);
        const result = yield* runs.settled(service, reference);
        assert.equal(result.run, null);
        assert.isTrue(yield* Deferred.isDone(stored));
        assert.equal(result.guide?.headSha, original.headSha);
        assert.isFalse(
          result.guide?.stops
            .flatMap((stop) => stop.files)
            .some((file) => file.path === "consumer.ts"),
        );
        yield* assertCleaned(workspace, paths);
      }),
    ),
  );

  it.effect("stores a guide when shared change reads need a missing promisor blob", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const original = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        const { remote } = original;
        const workspace = `${original.root}/partial-workspace`;
        yield* git(remote, ["config", "uploadpack.allowFilter", "true"]);
        yield* git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
        yield* git(original.root, [
          "clone",
          "--quiet",
          "--no-local",
          "--filter=blob:none",
          remote,
          workspace,
        ]);
        yield* git(remote, ["checkout", "--quiet", "stack-base"]);
        yield* fs.writeFileString(`${remote}/base.txt`, "new base\nshared\n");
        yield* git(remote, ["commit", "--quiet", "-am", "Advance the base"]);
        const lowerSha = yield* git(remote, ["rev-parse", "HEAD"]);
        const missingBlob = yield* git(remote, ["rev-parse", "HEAD:base.txt"]);
        yield* git(remote, ["checkout", "--quiet", "-B", "feature"]);
        yield* fs.writeFileString(`${remote}/base.txt`, "new feature\nshared\nmore\n");
        yield* git(remote, ["commit", "--quiet", "-am", "Update the feature"]);
        const headSha = yield* git(remote, ["rev-parse", "HEAD"]);
        const localObjects = git(workspace, ["cat-file", "--batch-check", "--batch-all-objects"]);
        assert.notInclude(yield* localObjects, missingBlob);
        const stored = yield* Deferred.make<void>();
        const runs = yield* watchRuns;
        const paths: Array<string> = [];
        const context = yield* Layer.build(
          makeLayer({
            ...original,
            workspace,
            headSha,
            lowerSha,
            upperSha: headSha,
            stored,
            stack: { ...stack(original), layers: [] },
            generate: (input) =>
              Effect.sync(() => {
                paths.push(input.cwd, `${input.cwd}/../evidence`);
                return { stops: [] };
              }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* runs.generate(service, reference);
        const result = yield* runs.settled(service, reference);
        assert.equal(result.run, null);
        assert.isTrue(yield* Deferred.isDone(stored));
        assert.deepEqual(result.guide?.stops[0]?.files, [{ path: "base.txt" }]);
        assert.include(yield* localObjects, missingBlob);
        yield* assertCleaned(workspace, paths);
      }),
    ),
  );

  it.effect("does no evidence preparation for a generator that ignores it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const stored = yield* Deferred.make<void>();
        const runs = yield* watchRuns;
        let extraReads = 0;
        let evidenceDirectories = 0;
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: (input) =>
              Effect.sync(() => {
                assert(input.evidence);
                return { stops: [] };
              }),
          }).pipe(
            Layer.provide(
              Layer.succeed(GitVcsDriver.GitVcsDriver, {
                ...driver,
                execute: (call) =>
                  Effect.suspend(() => {
                    if (call.operation !== "PullRequestReviewGuideService.readEvidence")
                      return driver.execute(call);
                    extraReads++;
                    return Effect.fail(
                      new GitCommandError({
                        operation: call.operation,
                        cwd: call.cwd,
                        command: "git",
                        detail: "Preparation must remain unused",
                      }),
                    );
                  }),
              }),
            ),
            Layer.provide(
              Layer.succeed(FileSystem.FileSystem, {
                ...fs,
                makeDirectory: (path, options) =>
                  Effect.suspend(() => {
                    if (path.endsWith("/evidence")) evidenceDirectories++;
                    return fs.makeDirectory(path, options);
                  }),
              }),
            ),
          ),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* runs.generate(service, reference);
        const result = yield* runs.settled(service, reference);
        assert.equal(result.run, null);
        assert.isTrue(yield* Deferred.isDone(stored));
        assert.deepEqual(result.guide?.stops[0]?.files, [{ path: "feature.txt" }]);
        assert.equal(extraReads, 0);
        assert.equal(evidenceDirectories, 0);
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
        const result = yield* run.settled;
        assert.isFalse(yield* Deferred.isDone(run.stored), "a guide was written");
        assert.strictEqual(result.run?._tag, "Failed");
        const detail = result.run?._tag === "Failed" ? result.run.detail : "";
        for (const part of expected) assert.include(detail, part);
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

it.layer(layerBase)("Review guide evidence lifetime", (it) => {
  it.effect.each(["timeout", "interruption"] as const)(
    "removes unfinished evidence and interrupts preparation on %s",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const fs = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const stored = yield* Deferred.make<void>();
          const preparing = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const paths: Array<string> = [];
          const runs = yield* watchRuns;
          const context = yield* Layer.buildWithScope(
            makeLayer({
              ...repositories,
              stored,
              generate: (input) =>
                Effect.gen(function* () {
                  assert(input.evidence);
                  paths.push(input.cwd, `${input.cwd}/../evidence`);
                  yield* input.evidence;
                  return { stops: [] };
                }),
            }).pipe(
              Layer.provide(
                Layer.succeed(GitVcsDriver.GitVcsDriver, {
                  ...driver,
                  execute: (call) =>
                    call.operation === "PullRequestReviewGuideService.readEvidence"
                      ? Deferred.succeed(preparing, undefined).pipe(
                          Effect.andThen(Effect.never),
                          Effect.ensuring(Deferred.succeed(stopped, undefined)),
                        )
                      : driver.execute(call),
                }),
              ),
            ),
            scope,
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );
          yield* runs.generate(service, reference);
          yield* Deferred.await(preparing);
          assert.isFalse(yield* fs.exists(`${paths[0]}/../evidence/manifest.json`));
          if (reason === "timeout") yield* TestClock.adjust(60_000);
          else yield* Scope.close(scope, Exit.void);
          const result = reason === "timeout" ? yield* runs.settled(service, reference) : null;
          assert.isTrue(yield* Deferred.isDone(stopped));
          assert.isFalse(yield* Deferred.isDone(stored));
          assert.equal(result?.guide ?? null, null);
          if (result !== null) {
            assert.equal(result.run?._tag, "Failed");
            assert.include(
              result.run?._tag === "Failed" ? result.run.detail : "",
              "timed out after 60 seconds",
            );
          }
          yield* assertCleaned(repositories.workspace, paths);
        }),
      ),
  );
});
