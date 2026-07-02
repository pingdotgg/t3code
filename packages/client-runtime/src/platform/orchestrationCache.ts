import {
  EnvironmentId,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 2 as const;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  thread: OrchestrationV2ThreadProjectionJson,
});

/** Invalid orchestration caches are disposable and must never block live synchronization. */
export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
