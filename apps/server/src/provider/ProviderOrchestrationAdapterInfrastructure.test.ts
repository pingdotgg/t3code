import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
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

it.live("spawns the __cursor-sdk-worker CLI fast path and shuts down cleanly on close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const executable = yield* HostProcess.ExecutablePath;
      const entry = yield* path.fromFileUrl(new URL("../bin.ts", import.meta.url));
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, [entry, "__cursor-sdk-worker"], {
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      yield* Stream.run(
        Stream.encodeText(Stream.make(`${JSON.stringify({ id: 1, type: "close" })}\n`)),
        handle.stdin,
      );
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
      const exitCode = Number(yield* handle.exitCode);
      assert.strictEqual(exitCode, 0);
      assert.deepStrictEqual(JSON.parse(stdout.trim()), {
        type: "response",
        id: 1,
        ok: true,
        result: null,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
