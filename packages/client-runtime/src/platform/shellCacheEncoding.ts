import { OrchestrationV2ThreadShellJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { StoredOrchestrationShellSnapshot } from "./orchestrationCache.ts";

const ROWS_PER_CHUNK = 32;

// Effect's own yield resumes through `setImmediate` where the host defines it and a
// zero-delay timer otherwise. React Native's `setImmediate` is a microtask shim, so
// nothing from the host runs before the fiber resumes. A timer yields on every host;
// a browser can pass a yield that its timer clamping and throttling do not slow.
const yieldToHostTimer = Effect.callback<void>((resume) => {
  // @effect-diagnostics-next-line globalTimersInEffect:off - A host timer, not Effect.sleep, is the point.
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

const encodeThreadChunk = Schema.encodeEffect(Schema.Array(OrchestrationV2ThreadShellJson));
const EncodedRows = Schema.Array(Schema.Unknown);
const encodeEnvelope = Schema.encodeEffect(
  Schema.fromJsonString(
    StoredOrchestrationShellSnapshot.mapFields((fields) => ({
      ...fields,
      snapshot: fields.snapshot.mapFields((snapshotFields) => ({
        ...snapshotFields,
        threads: EncodedRows,
        archivedThreads: EncodedRows,
      })),
    })),
  ),
);

/**
 * Shell rows are immutable and the shell reducer keeps unchanged rows by
 * reference, so each encoder remembers the canonical encoding of rows it has
 * already encoded successfully and only runs the row codec for new rows.
 *
 * `yieldToHost` defaults to a zero-delay timer.
 */
export function makeStoredShellSnapshotEncoder(
  options: { readonly yieldToHost?: Effect.Effect<void> } = {},
) {
  const yieldToHost = options.yieldToHost ?? yieldToHostTimer;
  const encodedRows = new WeakMap<OrchestrationV2ThreadShellJson, unknown>();

  return Effect.fnUntraced(function* (stored: typeof StoredOrchestrationShellSnapshot.Type) {
    let hasWorked = false;
    const yieldBetweenChunks = Effect.suspend(() => {
      if (hasWorked) return yieldToHost;
      hasWorked = true;
      return Effect.void;
    });
    const encodeMisses = (misses: ReadonlyArray<OrchestrationV2ThreadShellJson>) =>
      Effect.gen(function* () {
        yield* yieldBetweenChunks;
        const chunk = yield* encodeThreadChunk(misses);
        chunk.forEach((row, index) => encodedRows.set(misses[index]!, row));
      });
    const encodeRows = (rows: ReadonlyArray<OrchestrationV2ThreadShellJson>) =>
      Effect.gen(function* () {
        let misses: Array<OrchestrationV2ThreadShellJson> = [];
        for (const row of rows) {
          if (encodedRows.has(row)) continue;
          misses.push(row);
          if (misses.length === ROWS_PER_CHUNK) {
            yield* encodeMisses(misses);
            misses = [];
          }
        }
        if (misses.length > 0) yield* encodeMisses(misses);
        return rows.map((row) => encodedRows.get(row));
      });

    const { snapshot } = stored;
    const threads = yield* encodeRows(snapshot.threads);
    const archivedThreads = yield* encodeRows(snapshot.archivedThreads);
    if (hasWorked) yield* yieldToHost;
    return yield* encodeEnvelope({
      ...stored,
      snapshot: { ...snapshot, threads, archivedThreads },
    });
  });
}
