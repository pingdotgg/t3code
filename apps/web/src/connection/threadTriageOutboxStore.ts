import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";

const KEY = "t3code:thread-triage-outbox";

/** In localStorage, so tabs share it and clearing the environment cache keeps unsynced changes. */
export const browserThreadTriageOutboxStore = makeThreadTriageOutboxStore((next) =>
  Effect.try({
    try: () => {
      const value = next(window.localStorage.getItem(KEY));
      if (value !== null) window.localStorage.setItem(KEY, value);
    },
    catch: (cause) => new ThreadTriageOutboxStorageError({ cause }),
  }),
);
