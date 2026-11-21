import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderProcesses from "../process/providerProcesses.ts";
import type * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorAgentSdkProcessRunner from "@t3tools/provider-cursor/server/CursorAgentSdkProcessRunner";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DisplayModeCompactionNote from "../fork/displayModeWrap/DisplayModeCompactionNote.ts";
import type * as FyiDelivery from "../fork/fyi/FyiDelivery.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | DisplayModeCompactionNote.DisplayModeCompactionNote
  | FyiDelivery.FyiDelivery
  | IdAllocator.IdAllocatorV2;

// Subagent threads created before short ids keep their stored id when an adapter resumes them.
export const layerIdAllocator = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE thread_id LIKE 'thread:provider:%'
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.legacy-subagent-thread-ids-unavailable", {
          cause,
        }).pipe(Effect.as([])),
      ),
    );
    return IdAllocator.layerWithLegacySubagentThreads(new Set(rows.map((row) => row.threadId)));
  }),
);

const resolveCursorWorkerLaunch = Effect.gen(function* () {
  const path = yield* Path.Path;
  const command = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const providerProcesses = yield* ProviderProcesses.ProviderProcesses;
  // In a bundle import.meta.url is bin.mjs; development and tests use this source module.
  const entry = yield* path
    .fromFileUrl(
      new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
    )
    .pipe(Effect.orDie);
  return {
    command,
    args: [...(isExecutable ? [] : [entry]), "__cursor-sdk-worker"],
    ...(providerProcesses.register === undefined
      ? {}
      : { registerProcess: providerProcesses.register }),
  };
});

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(
  ClaudeAdapterV2.layerQueryRunner,
  CodexAdapterV2.layerAppServerClientFactory,
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return CursorAgentSdkProcessRunner.layer(
        resolveCursorWorkerLaunch.pipe(Effect.provideService(Path.Path, path)),
      );
    }),
  ),
  CursorSdk.layer,
  DisplayModeCompactionNote.layer,
  RuntimeLayer.layerFyiDelivery,
  layerIdAllocator,
  ProviderContinuationRequests.layer,
);
