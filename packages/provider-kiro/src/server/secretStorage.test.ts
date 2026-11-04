import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
      assert.strictEqual((yield* fileSystem.stat(secretsPath)).mode & 0o777, 0o600);
      assert.deepStrictEqual(yield* sessions[1]!.get(keys[3]!), { value: '{"n":3}' });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
