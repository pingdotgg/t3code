import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { gitButlerRegistryPaths, makeForPaths } from "./GitButlerProjectRegistry.ts";

it.effect("resolves GitButler release, nightly, and development registries", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    expect(
      gitButlerRegistryPaths(
        { platform: "darwin", environment: {}, homeDir: "/Users/alice" },
        path,
      ),
    ).toEqual([
      "/Users/alice/Library/Application Support/com.gitbutler.app/projects.json",
      "/Users/alice/Library/Application Support/com.gitbutler.app.nightly/projects.json",
      "/Users/alice/Library/Application Support/com.gitbutler.app.dev/projects.json",
    ]);
    expect(
      gitButlerRegistryPaths(
        {
          platform: "linux",
          environment: { XDG_DATA_HOME: "/var/data" },
          homeDir: "/home/alice",
        },
        path,
      ),
    ).toEqual(["/var/data/gitbutler-tauri/projects.json"]);
    expect(
      gitButlerRegistryPaths(
        {
          platform: "linux",
          environment: { E2E_TEST_APP_DATA_DIR: "/tmp/gitbutler-test" },
          homeDir: "/home/alice",
        },
        path,
      ),
    ).toEqual(["/tmp/gitbutler-test/projects.json"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("matches registered paths and fails closed for malformed registries", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-gitbutler-registry-",
    });
    const registryPath = path.join(tempDirectory, "projects.json");
    yield* fileSystem.writeFileString(
      registryPath,
      '[{"id":"project-1","path":"/workspace/project"}]',
    );

    const registry = yield* makeForPaths([registryPath]);
    expect(yield* registry.registrationStatus("/workspace/project")).toBe("registered");
    expect(yield* registry.registrationStatus("/workspace/other")).toBe("unregistered");

    yield* fileSystem.writeFileString(registryPath, "not json");
    expect(yield* registry.registrationStatus("/workspace/project")).toBe("error");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
