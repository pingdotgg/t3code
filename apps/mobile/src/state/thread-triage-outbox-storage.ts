import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";

import { writeFileAtomically } from "../lib/atomic-file";

async function getStorageFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, "thread-triage-outbox.json");
}

async function readStorageFile() {
  const file = await getStorageFile();
  return file.exists ? await file.text() : null;
}

/** Lives outside the client cache so clearing cached data keeps unsynced settles and snoozes. */
export const mobileThreadTriageOutboxStore = makeThreadTriageOutboxStore({
  read: Effect.tryPromise({
    try: readStorageFile,
    catch: (cause) => new ThreadTriageOutboxStorageError({ cause }),
  }),
  // One process owns this file, and the store already serializes its own changes.
  modify: (next) =>
    Effect.tryPromise({
      try: async () => {
        const value = next(await readStorageFile());
        if (value !== null) await writeFileAtomically(await getStorageFile(), value);
      },
      catch: (cause) => new ThreadTriageOutboxStorageError({ cause }),
    }),
});
