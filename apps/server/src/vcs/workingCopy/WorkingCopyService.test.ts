import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ServerSettingsError,
  TextGenerationError,
  WorkingCopyCwdDeniedError,
  WorkingCopyNothingStagedError,
} from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import type * as VcsProcess from "../VcsProcess.ts";
import * as WorkingCopy from "./WorkingCopyService.ts";
import { WorkingCopyService } from "./WorkingCopyService.ts";

const TEST_EPOCH = "2024-01-01T00:00:00.000Z";

const okOutput: VcsProcess.VcsProcessOutput = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

interface Workspace {
  readonly projectRoots: ReadonlyArray<string>;
  readonly worktreePaths: ReadonlyArray<string>;
}

const projectionsLayer = (workspace: Workspace) =>
  Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        updatedAt: TEST_EPOCH,
        projects: workspace.projectRoots.map((workspaceRoot, index) => ({
          id: `project-${index}`,
          title: `project-${index}`,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: TEST_EPOCH,
          updatedAt: TEST_EPOCH,
        })),
        threads: workspace.worktreePaths.map((worktreePath, index) => ({
          id: `thread-${index}`,
          worktreePath,
        })),
      } as never),
  });

/**
 * A registry that answers with a fixed repository root and a recorded
 * executor. Nothing here spawns git: the assertions are about the guard and
 * the scheduler, not about git's behaviour.
 */
const registryLayer = (options: {
  readonly repositoryRoot: (cwd: string) => string;
  readonly execute?: (input: {
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, never>;
}) =>
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    resolve: (input) =>
      Effect.succeed({
        kind: "git" as const,
        repository: {
          kind: "git" as const,
          rootPath: options.repositoryRoot(input.cwd),
          metadataPath: null,
          freshness: { source: "live-local", observedAt: TEST_EPOCH, expiresAt: undefined },
        },
        driver: {
          execute: options.execute ?? (() => Effect.succeed(okOutput)),
        },
      } as never),
  });

/**
 * fork: f4 AI commit message — the three services generation added. Every test
 * in this file is about the guard and the scheduler, so all three are inert.
 */
const textGenerationLayer = Layer.mock(TextGeneration.TextGeneration)({});
const providerRegistryLayer = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});

const makeLayer = (
  workspace: Workspace,
  registry: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry>,
) =>
  WorkingCopy.layer.pipe(
    Layer.provide(registry),
    Layer.provide(projectionsLayer(workspace)),
    Layer.provide(textGenerationLayer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(providerRegistryLayer),
    Layer.provideMerge(NodeServices.layer),
  );

const identityRoot = (cwd: string) => cwd;

it.effect("denies a cwd outside every project root and thread worktree", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/tmp/somewhere-else" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
    assert.strictEqual(failure.cwd, "/tmp/somewhere-else");
    assert.strictEqual(failure.operation, "workingCopy.status");
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("denies a sibling directory whose name merely prefixes an allowed root", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/work/proj-evil" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("denies everything when the workspace has no projects and no worktrees", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/work/proj" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: [], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("denies a mutation on a denied cwd before any git runs", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service
      .stagePaths({ cwd: "/tmp/elsewhere", paths: ["a.ts"] })
      .pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
    // Denial happens before the driver is ever asked to run anything.
    assert.deepStrictEqual(calls, []);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({
          repositoryRoot: identityRoot,
          execute: (input) =>
            Effect.sync(() => {
              calls.push(input.args);
              return okOutput;
            }),
        }),
      ),
    ),
  );
});

it.effect("denies when the cwd is allowed but git resolves it to a repository root outside", () =>
  Effect.gen(function* () {
    // A project checked out *inside* a larger repository: without the second
    // guard the panel would operate on the outer repository's worktree.
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/work/proj/nested" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
    assert.strictEqual(failure.cwd, "/work");
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: () => "/work" }),
      ),
    ),
  ),
);

it.effect("allows a thread worktree that is not itself a project root", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    // Reaching git at all is the assertion: the guard let it through.
    const status = yield* service.status({ cwd: "/work/worktrees/thread-a" });

    assert.strictEqual(status.isRepo, true);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: ["/work/worktrees/thread-a"] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("serializes mutations per repository — the second waits for the first", () => {
  const order: Array<string> = [];
  let started = 0;
  let signalFirstStarted = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const execute = () =>
    Effect.gen(function* () {
      started += 1;
      const label = started === 1 ? "first" : "second";
      order.push(`${label}:start`);
      if (label === "first") {
        signalFirstStarted();
        yield* Effect.promise(() => firstReleased);
      }
      order.push(`${label}:end`);
      return okOutput;
    });

  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const first = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj", paths: ["a.ts"] }),
    );
    yield* Effect.promise(() => firstStarted);

    const second = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj", paths: ["b.ts"] }),
    );
    // Give the second fiber every chance to run. What stops it is the
    // per-repository semaphore, not the scheduler.
    for (let tick = 0; tick < 50; tick += 1) {
      yield* Effect.yieldNow;
    }
    assert.deepStrictEqual(order, ["first:start"]);

    yield* Effect.sync(() => releaseFirst());
    yield* Fiber.join(first);
    yield* Fiber.join(second);

    assert.deepStrictEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot, execute }),
      ),
    ),
  );
});

it.effect("does not serialize across different repositories", () => {
  const order: Array<string> = [];
  let started = 0;
  let signalFirstStarted = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const execute = () =>
    Effect.gen(function* () {
      started += 1;
      const label = started === 1 ? "first" : "second";
      order.push(`${label}:start`);
      if (label === "first") {
        signalFirstStarted();
        yield* Effect.promise(() => firstReleased);
      }
      order.push(`${label}:end`);
      return okOutput;
    });

  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const first = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj-a", paths: ["a.ts"] }),
    );
    yield* Effect.promise(() => firstStarted);

    const second = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj-b", paths: ["b.ts"] }),
    );
    yield* Fiber.join(second);

    // A busy repository must not block an idle one.
    assert.deepStrictEqual(order, ["first:start", "second:start", "second:end"]);

    yield* Effect.sync(() => releaseFirst());
    yield* Fiber.join(first);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj-a", "/work/proj-b"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot, execute }),
      ),
    ),
  );
});

// ─── fork: f4 AI commit message ─────────────────────────────────────────────

interface GenerationHarness {
  readonly workspace?: Workspace;
  /** stdout for `git diff --cached --name-status`; empty means "nothing staged". */
  readonly stagedSummary?: string;
  readonly generate?: (input: {
    readonly stagedSummary: string;
    readonly stagedPatch: string;
  }) => Effect.Effect<{ readonly subject: string; readonly body: string }, TextGenerationError>;
  readonly settings?: Layer.Layer<ServerSettings.ServerSettingsService>;
  readonly onGitArgs?: (args: ReadonlyArray<string>) => void;
}

const stdout = (value: string): VcsProcess.VcsProcessOutput => ({ ...okOutput, stdout: value });

/**
 * A git that answers only what generation asks for. Everything else answers
 * empty, which is enough for the guard/scheduler assertions below.
 */
const generationLayer = (harness: GenerationHarness) =>
  WorkingCopy.layer.pipe(
    Layer.provide(
      registryLayer({
        repositoryRoot: identityRoot,
        execute: (input) =>
          Effect.sync(() => {
            harness.onGitArgs?.(input.args);
            if (input.args.includes("--name-status")) {
              return stdout(harness.stagedSummary ?? "M\tsrc/a.ts\n");
            }
            if (input.args.includes("--patch")) {
              return stdout("diff --git a/src/a.ts b/src/a.ts\n");
            }
            if (input.args[0] === "symbolic-ref") {
              return stdout("main\n");
            }
            return okOutput;
          }),
      }),
    ),
    Layer.provide(
      projectionsLayer(harness.workspace ?? { projectRoots: ["/work/proj"], worktreePaths: [] }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateCommitMessage: (input) =>
          (harness.generate ?? (() => Effect.succeed({ subject: "Add a thing", body: "" })))({
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
          }),
      }),
    ),
    Layer.provide(harness.settings ?? ServerSettings.layerTest()),
    Layer.provide(providerRegistryLayer),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "generateCommitMessage denies a cwd outside every project before any git or model call",
  () => {
    const gitCalls: Array<ReadonlyArray<string>> = [];
    let generated = 0;
    return Effect.gen(function* () {
      const service = yield* WorkingCopyService;

      const failure = yield* service
        .generateCommitMessage({ cwd: "/tmp/elsewhere" })
        .pipe(Effect.flip);

      assert.instanceOf(failure, WorkingCopyCwdDeniedError);
      assert.strictEqual(failure.operation, "workingCopy.generateCommitMessage");
      assert.deepStrictEqual(gitCalls, []);
      assert.strictEqual(generated, 0);
    }).pipe(
      Effect.provide(
        generationLayer({
          onGitArgs: (args) => gitCalls.push(args),
          generate: () =>
            Effect.sync(() => {
              generated += 1;
              return { subject: "never", body: "" };
            }),
        }),
      ),
    );
  },
);

it.effect("generateCommitMessage refuses an empty index and never reaches the model", () => {
  let generated = 0;
  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.generateCommitMessage({ cwd: "/work/proj" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyNothingStagedError);
    assert.strictEqual(failure.amend, false);
    assert.strictEqual(failure.cwd, "/work/proj");
    // Generating from the unstaged tree instead would describe changes the
    // user is about to not commit.
    assert.strictEqual(generated, 0);
  }).pipe(
    Effect.provide(
      generationLayer({
        stagedSummary: "   \n",
        generate: () =>
          Effect.sync(() => {
            generated += 1;
            return { subject: "never", body: "" };
          }),
      }),
    ),
  );
});

it.effect("generateCommitMessage carries the amend flag into the refusal", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service
      .generateCommitMessage({ cwd: "/work/proj", amend: true })
      .pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyNothingStagedError);
    assert.strictEqual(failure.amend, true);
    assert.include(failure.message, "amended commit would be empty");
  }).pipe(Effect.provide(generationLayer({ stagedSummary: "" }))),
);

it.effect("generateCommitMessage surfaces a model failure as TextGenerationError", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.generateCommitMessage({ cwd: "/work/proj" }).pipe(Effect.flip);

    assert.instanceOf(failure, TextGenerationError);
    assert.include(failure.detail, "not available on PATH");
  }).pipe(
    Effect.provide(
      generationLayer({
        generate: () =>
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "Codex CLI (`codex`) is required but not available on PATH.",
          }),
      }),
    ),
  ),
);

it.effect("a settings failure arrives typed rather than as a raw defect", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.generateCommitMessage({ cwd: "/work/proj" }).pipe(Effect.flip);

    assert.instanceOf(failure, TextGenerationError);
    assert.strictEqual(failure.detail, "Could not read the text generation settings.");
  }).pipe(
    Effect.provide(
      generationLayer({
        settings: Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.fail(
            new ServerSettingsError({
              settingsPath: "/settings.json",
              operation: "read-file",
              cause: new Error("boom"),
            }),
          ),
        }),
      }),
    ),
  ),
);

it.effect("returns a sanitized, composer-ready message", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const result = yield* service.generateCommitMessage({ cwd: "/work/proj" });

    assert.deepStrictEqual(result, {
      subject: "Add a thing",
      body: "- detail",
      message: "Add a thing\n\n- detail",
    });
  }).pipe(
    Effect.provide(
      generationLayer({
        generate: () => Effect.succeed({ subject: "Add a thing.\n", body: "  - detail  " }),
      }),
    ),
  ),
);

it.effect("the model call does NOT hold the repository semaphore", () => {
  let releaseModel = () => {};
  let signalModelStarted = () => {};
  const modelStarted = new Promise<void>((resolve) => {
    signalModelStarted = resolve;
  });
  const modelReleased = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });

  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const generation = yield* Effect.forkChild(
      service.generateCommitMessage({ cwd: "/work/proj" }),
    );
    yield* Effect.promise(() => modelStarted);

    // A generation takes tens of seconds. If it held the per-repo semaphore
    // across the model call, this stage would hang until the model answered.
    yield* service.stagePaths({ cwd: "/work/proj", paths: ["a.ts"] });

    yield* Effect.sync(() => releaseModel());
    const result = yield* Fiber.join(generation);
    assert.strictEqual(result.subject, "Add a thing");
  }).pipe(
    Effect.provide(
      generationLayer({
        generate: () =>
          Effect.gen(function* () {
            signalModelStarted();
            yield* Effect.promise(() => modelReleased);
            return { subject: "Add a thing", body: "" };
          }),
      }),
    ),
  );
});
