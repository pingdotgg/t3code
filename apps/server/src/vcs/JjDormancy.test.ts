import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type * as JjRepo from "./JjRepo.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";

vi.mock("./JjRepo.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof JjRepo>()),
  JJ_REPOSITORY_DETECTION_ENABLED: false,
}));

it.effect("keeps colocated jj markers dormant in repository detection and discovery", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const created = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-dormancy-" });
    const root = yield* fs.realPath(created);
    yield* fs.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
    const processLayer = Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => {
        const args = input.args[0] === "-C" ? input.args.slice(2) : input.args;
        const command = args.join(" ");
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout:
            command === "rev-parse --is-inside-work-tree"
              ? "true\n"
              : command === "rev-parse --show-toplevel"
                ? `${root}\n`
                : command === "rev-parse --git-common-dir"
                  ? `${path.join(root, ".git")}\n`
                  : `${input.command} version 1.0.0\n`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    const registryLayer = Layer.effect(
      VcsDriverRegistry.VcsDriverRegistry,
      VcsDriverRegistry.make,
    ).pipe(
      Layer.provide(JjVcsDriver.layer),
      Layer.provide(VcsProjectConfig.layer),
      Layer.provide(processLayer),
    );
    const discoveryLayer = SourceControlDiscovery.layer.pipe(
      Layer.provide(ServerConfig.layerTest(root, { prefix: "t3-jj-dormancy-config-" })),
      Layer.provide(processLayer),
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          discover: Effect.succeed([]),
          resolveLink: () => undefined,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const detected = yield* registry.detect({ cwd: root });
      assert.strictEqual(detected?.kind, "git");
      assert.strictEqual(detected?.repository.rootPath, root);
      const jjDriver = yield* registry.get("jj").pipe(Effect.result);
      assert.strictEqual(jjDriver._tag, "Failure");
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const result = yield* discovery.discover;
      const jj = result.versionControlSystems.find((item) => item.kind === "jj");
      assert.ok(jj);
      assert.strictEqual(jj.implemented, false);
    }).pipe(Effect.provide(Layer.merge(registryLayer, discoveryLayer)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps Git checkpoints with unknown config while jj markers are dormant", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-config-dormancy-" });
    const processLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
    const registryLayer = VcsDriverRegistry.layer.pipe(Layer.provide(processLayer));
    const checkpointLayer = CheckpointStore.layer.pipe(Layer.provideMerge(registryLayer));
    yield* Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const git = (args: ReadonlyArray<string>) =>
        process.run({
          operation: "JjDormancy.test",
          command: "git",
          cwd: root,
          args,
        });
      yield* git(["init"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* fs.writeFileString(path.join(root, "file.txt"), "before\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "initial"]);
      yield* fs.makeDirectory(path.join(root, ".t3code"));
      yield* fs.writeFileString(
        path.join(root, ".t3code", "vcs.json"),
        '{"vcs":{"kind":"unknown"}}',
      );
      yield* fs.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      assert.strictEqual(
        (yield* registry.resolve({ cwd: root, requestedKind: "git" })).kind,
        "git",
      );
      assert.strictEqual((yield* registry.get("jj").pipe(Effect.result))._tag, "Failure");
      const store = yield* CheckpointStore.CheckpointStore;
      assert.isTrue(yield* store.supportsCheckpoints(root));
      const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("dormant-jj-config"), 0);
      yield* fs.writeFileString(path.join(root, "file.txt"), "after\n");
      yield* store.captureCheckpoint({ cwd: root, checkpointRef });
      assert.isTrue(yield* store.hasCheckpointRef({ cwd: root, checkpointRef }));
      const captured = yield* git(["show", `${checkpointRef}:file.txt`]);
      assert.strictEqual(captured.stdout, "after\n");
    }).pipe(
      Effect.provide(
        Layer.merge(checkpointLayer, processLayer).pipe(
          Layer.provide(ServerConfig.layerTest(root, { prefix: "t3-jj-config-dormancy-home-" })),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
