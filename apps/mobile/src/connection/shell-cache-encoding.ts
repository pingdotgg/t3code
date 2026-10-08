import { StoredOrchestrationShellSnapshot } from "@t3tools/client-runtime/platform";
import { OrchestrationV2ThreadShellJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ROWS_PER_CHUNK = 32;

// Effect's cooperative yield resumes through microtasks on React Native. A host
// timer lets input and rendering run between chunks of shell rows instead.
const yieldToHost = Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

// Rows go through the canonical row codec in chunks. The envelope codec then
// validates and encodes everything else, passing the encoded rows through as-is.
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
 * Make an encoder for the shell cache payload that produces exactly what
 * `fromJsonString(StoredOrchestrationShellSnapshot)` would, yielding to the host
 * between bounded chunks of thread rows. The final envelope encode and JSON
 * stringify still run synchronously over the whole payload.
 *
 * Shell rows are immutable and the shell reducer keeps unchanged rows by
 * reference, so each encoder remembers the canonical encoding of rows it has
 * already encoded successfully and only runs the row codec for new rows.
 */
export function makeStoredShellSnapshotEncoder() {
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
