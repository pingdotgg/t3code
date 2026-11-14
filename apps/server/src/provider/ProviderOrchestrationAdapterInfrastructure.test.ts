import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerIdAllocator } from "./ProviderOrchestrationAdapterInfrastructure.ts";

it.effect("subagent threads stored under a legacy id keep it when re-derived", () =>
  Effect.gen(function* () {
    const stored = {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeThreadId: "parent:task-1",
    };
    const legacyId = IdAllocator.deriveThreadFromProviderThread(stored);
    const layerStored = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${legacyId}, 'project-1', 'Subagent', 'claudeAgent', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'
          )
        `;
      }),
    ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const ids = yield* IdAllocator.IdAllocatorV2.pipe(
      Effect.provide(layerIdAllocator.pipe(Layer.provide(layerStored))),
    );

    assert.strictEqual(ids.derive.subagentThread(stored), legacyId);
    assert.match(
      ids.derive.subagentThread({ ...stored, nativeThreadId: "parent:task-2" }),
      /^thread:subagent:[0-9a-f]{16}$/,
    );
  }),
);
