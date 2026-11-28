import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { discoverCliproxySessionDirs } from "./cliproxySessionDirs.ts";

/** Isolates HomeDirectory and Environment so the default ~/.cli-proxy-api root is a temp dir. */
const layer = (home: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcess.HomeDirectory, home),
    Layer.succeed(HostProcess.Environment, {}),
  );

const writeFile = (path: Path.Path, fs: FileSystem.FileSystem, filePath: string) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, "{}\n");
  });

describe("discoverCliproxySessionDirs", () => {
  it.effect("finds a provider session dir nested under the default data dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });
      const leaf = path.join(home, ".cli-proxy-api", "accounts", "work", "projects");
      yield* writeFile(path, fs, path.join(leaf, "session-a.jsonl"));

      const dirs = yield* discoverCliproxySessionDirs({
        environment: {},
        leafName: "projects",
        filePattern: /\.jsonl$/,
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([leaf]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds session dirs under env-configured data dirs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });
      const root = path.join(home, "moved-cliproxy");
      const leaf = path.join(root, "codex", "sessions");
      yield* writeFile(path, fs, path.join(leaf, "2026", "11", "rollout-1.jsonl"));

      const dirs = yield* discoverCliproxySessionDirs({
        environment: { CLIPROXY_API_AUTH_DIR: root },
        leafName: "sessions",
        filePattern: /^rollout-.*\.jsonl$/,
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([leaf]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("enters dot-named provider homes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });
      const leaf = path.join(home, ".cli-proxy-api", "accounts", "work", ".claude", "projects");
      yield* writeFile(path, fs, path.join(leaf, "a.jsonl"));

      const dirs = yield* discoverCliproxySessionDirs({
        environment: {},
        leafName: "projects",
        filePattern: /\.jsonl$/,
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([leaf]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips leaf dirs without a matching file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });
      const leaf = path.join(home, ".cli-proxy-api", "work", "sessions");
      yield* writeFile(path, fs, path.join(leaf, "notes.txt"));

      const dirs = yield* discoverCliproxySessionDirs({
        environment: {},
        leafName: "sessions",
        filePattern: /\.jsonl$/,
        fileProbeDepth: 0,
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("probe depth 0 does not match nested files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });
      const leaf = path.join(home, ".cli-proxy-api", "codex", "sessions");
      yield* writeFile(path, fs, path.join(leaf, "2026", "11", "rollout-1.jsonl"));

      const dirs = yield* discoverCliproxySessionDirs({
        environment: {},
        leafName: "sessions",
        filePattern: /\.jsonl$/,
        fileProbeDepth: 0,
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not repeat directories the reader already scans", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });
      const leaf = path.join(home, ".cli-proxy-api", "claude", "projects");
      yield* writeFile(path, fs, path.join(leaf, "a.jsonl"));

      const dirs = yield* discoverCliproxySessionDirs({
        environment: {},
        leafName: "projects",
        filePattern: /\.jsonl$/,
        exclude: [leaf],
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns nothing when no CLIProxyAPI data dir exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cliproxy-home-" });

      const dirs = yield* discoverCliproxySessionDirs({
        environment: {},
        leafName: "projects",
        filePattern: /\.jsonl$/,
      }).pipe(Effect.provide(layer(home)));

      expect(dirs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
