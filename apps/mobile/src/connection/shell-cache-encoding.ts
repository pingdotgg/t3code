import { StoredOrchestrationShellSnapshot } from "@t3tools/client-runtime/platform";
import { OrchestrationV2ThreadShellJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Effect's cooperative yield resumes through microtasks on React Native. A host
// timer lets input and rendering run between batches of shell rows instead.
const yieldToHost = Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

// Share the row budget across saves and environments; this bounds batches, not elapsed time.
let encodedRows = 0;
const CooperativeThreadShell = OrchestrationV2ThreadShellJson.pipe(
  Schema.middlewareEncoding<typeof OrchestrationV2ThreadShellJson, never>((effect) =>
    Effect.flatMap(effect, (value) => {
      encodedRows++;
      if (encodedRows < 32) return Effect.succeed(value);
      encodedRows = 0;
      return Effect.as(yieldToHost, value);
    }),
  ),
);

const CooperativeStoredShellSnapshot = StoredOrchestrationShellSnapshot.mapFields((fields) => ({
  ...fields,
  snapshot: fields.snapshot.mapFields((snapshotFields) => ({
    ...snapshotFields,
    threads: Schema.Array(CooperativeThreadShell),
    archivedThreads: Schema.Array(CooperativeThreadShell),
  })),
}));

/** Preserve the cache codec's validation and transforms while yielding during large saves. */
export const encodeStoredShellSnapshot = Schema.encodeEffect(
  Schema.fromJsonString(CooperativeStoredShellSnapshot),
);
