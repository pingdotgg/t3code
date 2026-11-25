import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";

import { writeFileAtomically } from "../lib/atomic-file";

/** A file outside the client cache, so clearing cached data keeps unsynced settles and snoozes. */
export const mobileThreadTriageOutboxStore = makeThreadTriageOutboxStore((next) =>
  Effect.tryPromise({
    try: async () => {
      const { File, Paths } = await import("expo-file-system");
      const file = new File(Paths.document, "thread-triage-outbox.json");
      const value = next(file.exists ? await file.text() : null);
      if (value !== null) await writeFileAtomically(file, value);
    },
    catch: (cause) => new ThreadTriageOutboxStorageError({ cause }),
  }),
);
