import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it, assert } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderSessionRepository } from "../Services/ProviderSessions.ts";
import { ProviderSessionRepositoryLive } from "./ProviderSessions.ts";

function makeRepositoryLayer<E, R>(
  persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
) {
  return ProviderSessionRepositoryLive.pipe(Layer.provide(persistenceLayer));
}

it.effect("ProviderSessionRepositoryLive upserts, lists, gets, and deletes sessions", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRepository;

    yield* repository.upsertSession({
      sessionId: "sess-1",
      provider: "codex",
      threadId: "thread-1",
    });
    yield* repository.upsertSession({
      sessionId: "sess-2",
      provider: "claudeCode",
    });

    const all = yield* repository.listSessions();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.sessionId, "sess-1");
    assert.equal(all[1]?.sessionId, "sess-2");

    const existing = yield* repository.getSession({ sessionId: "sess-1" });
    assert.equal(Option.isSome(existing), true);
    if (Option.isSome(existing)) {
      assert.equal(existing.value.provider, "codex");
      assert.equal(existing.value.threadId, "thread-1");
    }

    yield* repository.deleteSession({ sessionId: "sess-2" });
    const afterDelete = yield* repository.listSessions();
    assert.deepEqual(afterDelete.map((entry) => entry.sessionId), ["sess-1"]);
  }).pipe(Effect.provide(makeRepositoryLayer(SqlitePersistenceMemory))),
);

it.effect("ProviderSessionRepositoryLive persists sessions across layer restarts", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-sessions-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const repositoryLayer = makeRepositoryLayer(makeSqlitePersistenceLive(dbPath));

    yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRepository;
      yield* repository.upsertSession({
        sessionId: "sess-persisted",
        provider: "codex",
        threadId: "thread-persisted",
      });
    }).pipe(Effect.provide(repositoryLayer));

    const persisted = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRepository;
      return yield* repository.getSession({ sessionId: "sess-persisted" });
    }).pipe(Effect.provide(repositoryLayer));

    assert.equal(Option.isSome(persisted), true);
    if (Option.isSome(persisted)) {
      assert.equal(persisted.value.provider, "codex");
      assert.equal(persisted.value.threadId, "thread-persisted");
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);
