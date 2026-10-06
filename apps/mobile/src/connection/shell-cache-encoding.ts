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
 * Encode the shell cache payload exactly like `fromJsonString(StoredOrchestrationShellSnapshot)`,
 * yielding to the host between bounded chunks of thread rows. The final envelope encode and
 * JSON stringify still run synchronously over the whole payload.
 */
export const encodeStoredShellSnapshot = Effect.fnUntraced(function* (
  stored: typeof StoredOrchestrationShellSnapshot.Type,
) {
  let hasWorked = false;
  const yieldBetweenChunks = Effect.suspend(() => {
    if (hasWorked) return yieldToHost;
    hasWorked = true;
    return Effect.void;
  });
  const encodeRows = (rows: ReadonlyArray<OrchestrationV2ThreadShellJson>) =>
    Effect.gen(function* () {
      const encoded: Array<unknown> = [];
      for (let start = 0; start < rows.length; start += ROWS_PER_CHUNK) {
        yield* yieldBetweenChunks;
        const chunk = yield* encodeThreadChunk(rows.slice(start, start + ROWS_PER_CHUNK));
        for (const row of chunk) encoded.push(row);
      }
      return encoded;
    });

  const { snapshot } = stored;
  const threads = yield* encodeRows(snapshot.threads);
  const archivedThreads = yield* encodeRows(snapshot.archivedThreads);
  yield* yieldBetweenChunks;
  return yield* encodeEnvelope({ ...stored, snapshot: { ...snapshot, threads, archivedThreads } });
});
