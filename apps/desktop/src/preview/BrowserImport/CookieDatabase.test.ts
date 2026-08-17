import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { snapshotCookieDatabase } from "./CookieDatabase.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => effect;

describe("snapshotCookieDatabase", () => {
  it.effect("copies the write-ahead sidecars alongside the database", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-snap-" });
        const source = `${directory}/Cookies`;
        yield* fileSystem.writeFileString(source, "db");
        yield* fileSystem.writeFileString(`${source}-wal`, "wal");

        const snapshot = yield* snapshotCookieDatabase(source);

        assert.equal(yield* fileSystem.readFileString(snapshot), "db");
        assert.equal(yield* fileSystem.readFileString(`${snapshot}-wal`), "wal");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    ),
  );

  it.effect("treats an absent sidecar as normal", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-snap-" });
        const source = `${directory}/Cookies`;
        // A closed browser has already checkpointed its WAL away, which is the
        // common case rather than a failure.
        yield* fileSystem.writeFileString(source, "db");

        const snapshot = yield* snapshotCookieDatabase(source);

        assert.equal(yield* fileSystem.readFileString(snapshot), "db");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    ),
  );

  it.effect("fails when a sidecar exists but cannot be read", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-snap-" });
        const source = `${directory}/Cookies`;
        yield* fileSystem.writeFileString(source, "db");
        // A sidecar that is present but uncopyable, rather than absent.
        yield* fileSystem.makeDirectory(`${source}-wal`);

        // Ignoring this would open the snapshot without its write-ahead log
        // and silently return a cookie set missing its newest transactions.
        const error = yield* snapshotCookieDatabase(source).pipe(Effect.scoped, Effect.flip);

        assert.notEqual(error.reason._tag, "NotFound");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    ),
  );
});
