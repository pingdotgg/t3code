import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const layerTest = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("VcsProjectConfig", () => {
  it.layer(layerTest)("discovers .t3code/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(layerTest)("continues to parent configs after a candidate inspect failure", (it) => {
    it.effect("logs the failed candidate and returns the parent config", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const cwd = path.join(root, "invalid\0child");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd });

        assert.equal(kind, "jj");
        const failedCandidate = path.join(cwd, ".t3code", "vcs.json");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to inspect VCS project config at " + failedCandidate + ".",
        );
        assert.deepInclude(error, {
          operation: "inspect",
          cwd,
          configPath: failedCandidate,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(layerTest)("falls back to auto when no config exists", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );

    it.effect("returns the default branch naming policy", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const branchNaming = yield* config.resolveBranchNaming({ cwd: root });

        assert.deepStrictEqual(branchNaming, {
          defaultPrefix: "feature",
          preserveNamespaces: false,
        });
      }),
    );

    it.effect("returns no project hooks", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const hooks = yield* config.resolveHooks({ cwd: root });

        assert.deepStrictEqual(hooks, { afterPush: null });
      }),
    );
  });

  it.layer(layerTest)("resolves project branch naming conventions", (it) => {
    it.effect("supports unprefixed, namespaced branch names from nested workspaces", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({
            branchNaming: {
              defaultPrefix: null,
              preserveNamespaces: true,
            },
          }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const branchNaming = yield* config.resolveBranchNaming({ cwd: nested });

        assert.deepStrictEqual(branchNaming, {
          defaultPrefix: null,
          preserveNamespaces: true,
        });
      }),
    );
  });

  it.layer(layerTest)("resolves project hooks", (it) => {
    it.effect("returns after-push commands from a parent config", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({
            hooks: {
              afterPush: ["./scripts/populate-cache", "./scripts/notify-ci"],
              changeRequestContext: "printf '[]'",
            },
          }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const hooks = yield* config.resolveHooks({ cwd: nested });
        assert.equal(yield* config.resolveChangeRequestContext({ cwd: nested }), "printf '[]'");

        assert.deepStrictEqual(hooks, {
          afterPush: ["./scripts/populate-cache", "./scripts/notify-ci"],
        });
      }),
    );

    it.effect("returns argv-style after-push commands", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({
            hooks: {
              changeRequestContext: ["node", "-e", "console.log('[]')"],
              afterPush: [
                ["./scripts/populate-cache", "--ref", "feature/example"],
                ["./scripts/notify-ci"],
              ],
            },
          }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const hooks = yield* config.resolveHooks({ cwd: root });
        assert.deepStrictEqual(yield* config.resolveChangeRequestContext({ cwd: root }), [
          "node",
          "-e",
          "console.log('[]')",
        ]);

        assert.deepStrictEqual(hooks, {
          afterPush: [
            ["./scripts/populate-cache", "--ref", "feature/example"],
            ["./scripts/notify-ci"],
          ],
        });
      }),
    );
  });

  it.layer(layerTest)("falls back to auto when config JSON is malformed", (it) => {
    it.effect("returns auto and logs the failed operation and path", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "vcs.json"), "{not json");

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        const contextResult = yield* config
          .resolveChangeRequestContext({ cwd: root })
          .pipe(Effect.result);
        assert.deepInclude(contextResult, { _tag: "Failure" });
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to decode VCS project config at " + path.join(configDir, "vcs.json") + ".",
        );
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
        assert.deepInclude(error, {
          operation: "decode",
          cwd: root,
          configPath: path.join(configDir, "vcs.json"),
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });
});
