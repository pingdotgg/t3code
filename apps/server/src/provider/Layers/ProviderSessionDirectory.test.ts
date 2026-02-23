import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it, assert } from "@effect/vitest";
import { assertFailure, assertSome } from "@effect/vitest/utils";
import { Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRepositoryLive } from "../../persistence/Layers/ProviderSessions.ts";
import { ProviderSessionNotFoundError, ProviderValidationError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  return ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRepositoryLive),
    Layer.provide(persistenceLayer),
  );
}

function makeAdapter(activeSessionIds: ReadonlySet<string>): ProviderAdapterShape<ProviderAdapterError> {
  const unsupported = () => Effect.die(new Error("unsupported test operation")) as never;
  return {
    provider: "codex",
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    hasSession: (sessionId) => Effect.succeed(activeSessionIds.has(sessionId)),
    readThread: () => unsupported(),
    rollbackThread: () => unsupported(),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

const layer = it.layer(makeDirectoryLayer(SqlitePersistenceMemory));

layer("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes session bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;

      yield* directory.upsert({
        sessionId: "sess-1",
        provider: "codex",
        threadId: "thread-1",
      });

      const provider = yield* directory.getProvider("sess-1");
      assert.equal(provider, "codex");
      const threadId = yield* directory.getThreadId("sess-1");
      assertSome(threadId, "thread-1");

      yield* directory.upsert({
        sessionId: "sess-1",
        provider: "codex",
        threadId: "thread-2",
      });
      const updatedThreadId = yield* directory.getThreadId("sess-1");
      assertSome(updatedThreadId, "thread-2");

      const sessionIds = yield* directory.listSessionIds();
      assert.deepEqual(sessionIds, ["sess-1"]);

      yield* directory.remove("sess-1");
      const missingProvider = yield* directory.getProvider("sess-1").pipe(Effect.result);
      assertFailure(missingProvider, new ProviderSessionNotFoundError({ sessionId: "sess-1" }));
    }));

  it("fails upsert for empty session id", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const result = yield* Effect.result(
        directory.upsert({
          sessionId: "   ",
          provider: "codex",
        }),
      );
      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "sessionId must be a non-empty string.",
        }),
      );
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-directory-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          sessionId: "sess-restart",
          provider: "codex",
          threadId: "thread-restart",
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const provider = yield* directory.getProvider("sess-restart");
        assert.equal(provider, "codex");

        const threadId = yield* directory.getThreadId("sess-restart");
        assertSome(threadId, "thread-restart");
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)));

  it("reconciles stale sessions and keeps active mappings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;

      yield* directory.upsert({
        sessionId: "sess-active",
        provider: "codex",
        threadId: "thread-active",
      });
      yield* directory.upsert({
        sessionId: "sess-stale",
        provider: "codex",
        threadId: "thread-stale",
      });

      const pruned = yield* directory.reconcileWithAdapters([
        makeAdapter(new Set(["sess-active"])),
      ]);
      assert.deepEqual(pruned, ["sess-stale"]);

      const remaining = yield* directory.listSessionIds();
      assert.deepEqual(remaining, ["sess-active"]);
    }));
});
