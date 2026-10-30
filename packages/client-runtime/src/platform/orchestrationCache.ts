import {
  EnvironmentId,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 3 as const;
// Older caches may contain human turns that bypassed server history budgets. 8 drops records an
// older client wrote without file changes' `diffOmitted`; a resumed thread replays only newer
// events, so those rows would never fetch their diff. 6 and 7 are compact record versions
// (threadCacheEncoding.ts): skipping them keeps mobile from reading a compact record as a full one.
export const ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION = 8 as const;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
