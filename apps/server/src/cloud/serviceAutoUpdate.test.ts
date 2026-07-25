import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  compareVersions,
  parseGitHubRepositoryUrl,
  pruneSupersededStagedBinaries,
  resolveManagedService,
  resolveServiceUpdateCandidate,
} from "./serviceAutoUpdate.ts";

it.effect("prunes superseded staged binaries while retaining the running version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-update-prune-" });
      const current = path.join(root, "0.0.28-f8y.10");
      const old = path.join(root, "0.0.28-f8y.9");
      yield* fs.makeDirectory(current, { recursive: true });
      yield* fs.makeDirectory(old, { recursive: true });
      yield* fs.writeFileString(path.join(current, "t3"), "current");
      yield* fs.writeFileString(path.join(old, "t3"), "old");

      yield* pruneSupersededStagedBinaries({
        repositoryRuntimeDir: root,
        currentVersion: "0.0.28-f8y.10",
      });

      assert.isTrue(yield* fs.exists(current));
      assert.isFalse(yield* fs.exists(old));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("accepts only an exact GitHub repository URL", () => {
  assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/totalolage/t3code"), {
    owner: "totalolage",
    repo: "t3code",
  });
  assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/totalolage/t3code.git/"), {
    owner: "totalolage",
    repo: "t3code",
  });
  assert.isNull(parseGitHubRepositoryUrl("http://github.com/totalolage/t3code"));
  assert.isNull(parseGitHubRepositoryUrl("https://github.com/totalolage/t3code/releases"));
  assert.isNull(parseGitHubRepositoryUrl("https://example.com/totalolage/t3code"));
});

it("orders f8y builds without changing the upstream numeric version", () => {
  assert.isAbove(compareVersions("0.0.28-f8y.20260724.30", "0.0.28-f8y.20260724.29"), 0);
  assert.isAbove(compareVersions("0.0.29", "0.0.28-f8y.20260724.99"), 0);
  assert.isAbove(compareVersions("0.0.28-f8y.20260724.29", "0.0.28"), 0);
});

it("requires a binary and adjacent checksum for the current platform", () => {
  assert.deepEqual(
    resolveServiceUpdateCandidate({
      currentVersion: "0.0.28-f8y.20260724.28",
      platformAsset: "linux-x64",
      releases: [
        {
          version: "0.0.28-f8y.20260724.29",
          assets: [
            {
              name: "t3-0.0.28-f8y.20260724.29-linux-x64",
              browserDownloadUrl: "https://example.test/t3",
            },
            {
              name: "t3-0.0.28-f8y.20260724.29-linux-x64.sha256",
              browserDownloadUrl: "https://example.test/t3.sha256",
            },
          ],
        },
      ],
    }),
    {
      version: "0.0.28-f8y.20260724.29",
      assetName: "t3-0.0.28-f8y.20260724.29-linux-x64",
      binaryUrl: "https://example.test/t3",
      checksumUrl: "https://example.test/t3.sha256",
    },
  );
});

it.effect("detects only explicitly marked managed systemd and s6 services", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.deepEqual(
      resolveManagedService({
        env: {
          HOME: "/home/theo",
          T3_SERVICE_SUPERVISOR: "s6",
          T3_S6_SERVICE_DIR: "/run/service/t3code",
          T3_S6_SERVICE_USER: "1000",
          T3_S6_SERVICE_GROUP: "1000",
          T3_S6_SERVICE_LAUNCHER: "/home/theo/.t3/runtime/s6-service-launcher",
        },
        homeDir: "/home/theo",
        path,
      }),
      {
        supervisor: "s6",
        serviceDir: "/run/service/t3code",
        definitionPath: "/run/service/t3code/run",
        serviceUser: "1000",
        serviceGroup: "1000",
        launcherPath: "/home/theo/.t3/runtime/s6-service-launcher",
      },
    );
    assert.equal(
      resolveManagedService({ env: { HOME: "/home/theo" }, homeDir: "/home/theo", path }),
      null,
    );
    assert.equal(
      resolveManagedService({
        env: {
          T3_SERVICE_SUPERVISOR: "s6",
          T3_S6_SERVICE_DIR: "/run/service/t3code",
        },
        homeDir: "/home/theo",
        path,
      }),
      null,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
