import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { ProviderSessionId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { assertFailure, assertSome } from "@effect/vitest/utils";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionNotFoundError, ProviderValidationError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const sessionId = (value: string) => ProviderSessionId.makeUnsafe(value);
const threadId = (value: string) => ThreadId.makeUnsafe(value);
const providerThreadId = (value: string) => ProviderThreadId.makeUnsafe(value);

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
  );
}

const layer = it.layer(makeDirectoryLayer(SqlitePersistenceMemory));

layer("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes session bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      yield* directory.upsert({
        sessionId: sessionId("sess-1"),
        provider: "codex",
        threadId: threadId("thread-1"),
      });

      const provider = yield* directory.getProvider(sessionId("sess-1"));
      assert.equal(provider, "codex");
      const resolvedThreadId = yield* directory.getThreadId(sessionId("sess-1"));
      assertSome(resolvedThreadId, threadId("thread-1"));

      yield* directory.upsert({
        sessionId: sessionId("sess-1"),
        provider: "codex",
        threadId: threadId("thread-2"),
      });
      const updatedThreadId = yield* directory.getThreadId(sessionId("sess-1"));
      assertSome(updatedThreadId, threadId("thread-2"));

      const runtime = yield* runtimeRepository.getBySessionId({
        providerSessionId: sessionId("sess-1"),
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, "thread-2");
        assert.equal(runtime.value.providerThreadId, "thread-2");
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.adapterKey, "codex");
      }

      const sessionIds = yield* directory.listSessionIds();
      assert.deepEqual(sessionIds, [sessionId("sess-1")]);

      yield* directory.remove(sessionId("sess-1"));
      const missingProvider = yield* directory.getProvider(sessionId("sess-1")).pipe(Effect.result);
      assertFailure(missingProvider, new ProviderSessionNotFoundError({ sessionId: "sess-1" }));
    }));

  it("fails upsert when thread id is unavailable", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const result = yield* Effect.result(
        directory.upsert({
          sessionId: sessionId("sess-no-thread"),
          provider: "codex",
        }),
      );
      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "threadId must be a non-empty string.",
        }),
      );
    }));

  it("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      yield* directory.upsert({
        sessionId: sessionId("sess-runtime"),
        provider: "codex",
        threadId: threadId("thread-runtime"),
        providerThreadId: providerThreadId("provider-thread-runtime"),
        status: "starting",
        resumeCursor: {
          resumeThreadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        sessionId: sessionId("sess-runtime"),
        provider: "codex",
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getBySessionId({
        providerSessionId: sessionId("sess-runtime"),
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, "thread-runtime");
        assert.equal(runtime.value.providerThreadId, "provider-thread-runtime");
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          resumeThreadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-directory-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          sessionId: sessionId("sess-restart"),
          provider: "codex",
          threadId: threadId("thread-restart"),
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(sessionId("sess-restart"));
        assert.equal(provider, "codex");

        const resolvedThreadId = yield* directory.getThreadId(sessionId("sess-restart"));
        assertSome(resolvedThreadId, threadId("thread-restart"));

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)));
});
