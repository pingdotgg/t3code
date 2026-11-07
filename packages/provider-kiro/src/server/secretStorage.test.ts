import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { makeKiroSecretStorage } from "./secretStorage.ts";

describe("makeKiroSecretStorage", () => {
  it.effect("keeps every key when two sessions store at once, in a new 0600 file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const environment = { KIRO_HOME: ` ${path.join(root, "missing", "kiro")} ` };
      const sessions = [
        yield* makeKiroSecretStorage(environment),
        yield* makeKiroSecretStorage(environment),
      ];
      const keys = Array.from({ length: 20 }, (_, index) => `kiro.mcp.${index}.tokens`);
      yield* Effect.forEach(
        keys,
        (key, index) => sessions[index % 2]!.store(key, `{"n":${index}}`),
        { concurrency: "unbounded", discard: true },
      );

      const secretsPath = path.join(root, "missing", "kiro", "secrets.json");
      const stored = JSON.parse(yield* fileSystem.readFileString(secretsPath));
      assert.deepStrictEqual(Object.keys(stored).toSorted(), keys.toSorted());
      // Windows reports every writable file as 0666.
      if ((yield* HostProcess.Platform) !== "win32") {
        assert.strictEqual((yield* fileSystem.stat(secretsPath)).mode & 0o777, 0o600);
      }
      assert.deepStrictEqual(yield* sessions[1]!.get(keys[3]!), { value: '{"n":3}' });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps the stored sign-ins when a write fails partway", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const secretsPath = path.join(root, "secrets.json");
      const original = JSON.stringify({ "kiro.mcp.a.tokens": "A" }, null, 2);
      yield* fileSystem.writeFileString(secretsPath, original);
      // Writes half the text and then fails, like a full disk.
      const failingWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (target, text, options) =>
          fileSystem.writeFileString(target, text.slice(0, text.length / 2), options).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: target,
                }),
              ),
            ),
          ),
      });
      const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingWrites),
      );

      assert.isTrue(Exit.isFailure(yield* Effect.exit(storage.store("kiro.mcp.b.tokens", "B"))));
      assert.strictEqual(yield* fileSystem.readFileString(secretsPath), original);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(root), ["secrets.json"]);
      assert.deepStrictEqual(yield* storage.get("kiro.mcp.a.tokens"), { value: "A" });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("leaves a secrets file it cannot decode untouched", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const secretsPath = path.join(root, "secrets.json");
      const original = '{"kiro.mcp.a.tokens":"A","kiro.other":{"nested":true}}';
      yield* fileSystem.writeFileString(secretsPath, original);
      const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root });

      assert.deepStrictEqual(yield* storage.get("kiro.mcp.a.tokens"), { value: null });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(storage.store("kiro.mcp.b.tokens", "B"))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(storage.remove("kiro.mcp.a.tokens"))));
      assert.strictEqual(yield* fileSystem.readFileString(secretsPath), original);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
