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

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes session bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const sessionId = ProviderSessionId.makeUnsafe("sess-1");
      const initialThreadId = ThreadId.makeUnsafe("thread-1");

      yield* directory.upsert({
        sessionId,
        provider: "codex",
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(sessionId);
      assert.equal(provider, "codex");
      const resolvedThreadId = yield* directory.getThreadId(sessionId);
      assertSome(resolvedThreadId, initialThreadId);

      const nextThreadId = ThreadId.makeUnsafe("thread-2");

      yield* directory.upsert({
        sessionId: sessionId,
        provider: "codex",
        threadId: nextThreadId,
      });
      const updatedThreadId = yield* directory.getThreadId(sessionId);
      assertSome(updatedThreadId, nextThreadId);
      const updatedBinding = yield* directory.getBinding(sessionId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
        assert.equal(updatedBinding.value.providerThreadId, null);
      }

      const runtime = yield* runtimeRepository.getBySessionId({
        providerSessionId: sessionId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.providerThreadId, null);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.adapterKey, "codex");
      }

      const sessionIds = yield* directory.listSessionIds();
      assert.deepEqual(sessionIds, [sessionId]);

      yield* directory.remove(sessionId);
      const missingProvider = yield* directory.getProvider(sessionId).pipe(Effect.result);
      assertFailure(missingProvider, new ProviderSessionNotFoundError({ sessionId: "sess-1" }));
    }));

  it("fails upsert when thread id is unavailable", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const result = yield* Effect.result(
        directory.upsert({
          sessionId: ProviderSessionId.makeUnsafe("sess-no-thread"),
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

      const sessionId = ProviderSessionId.makeUnsafe("sess-runtime");
      const threadId = ThreadId.makeUnsafe("thread-runtime");
      const providerThreadId = ProviderThreadId.makeUnsafe("provider-thread-runtime");

      yield* directory.upsert({
        sessionId,
        provider: "codex",
        threadId,
        providerThreadId,
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
        sessionId,
        provider: "codex",
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getBySessionId({
        providerSessionId: sessionId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.providerThreadId, providerThreadId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          resumeThreadId: providerThreadId,
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

      const sessionId = ProviderSessionId.makeUnsafe("sess-restart");
      const threadId = ThreadId.makeUnsafe("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          sessionId,
          provider: "codex",
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(sessionId);
        assert.equal(provider, "codex");

        const resolvedThreadId = yield* directory.getThreadId(sessionId);
        assertSome(resolvedThreadId, threadId);

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
