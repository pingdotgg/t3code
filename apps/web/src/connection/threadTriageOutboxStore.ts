import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";

const DATABASE_NAME = "t3code-thread-triage-outbox";
const STORE_NAME = "outbox";
const KEY = "document";

const openDatabase = Effect.callback<IDBDatabase, ThreadTriageOutboxStorageError>((resume) => {
  try {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("error", () =>
      resume(Effect.fail(new ThreadTriageOutboxStorageError({ cause: request.error }))),
    );
    request.addEventListener("success", () => resume(Effect.succeed(request.result)));
  } catch (cause) {
    resume(Effect.fail(new ThreadTriageOutboxStorageError({ cause })));
  }
});

/** Succeeds once the transaction commits; `abort` rolls it back and fails with that cause. */
const transact = (
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, abort: (cause: unknown) => void) => void,
) =>
  Effect.acquireUseRelease(
    openDatabase,
    (database) =>
      Effect.callback<void, ThreadTriageOutboxStorageError>((resume) => {
        let failure: unknown;
        try {
          const transaction = database.transaction(STORE_NAME, mode);
          transaction.addEventListener("complete", () => resume(Effect.void));
          transaction.addEventListener("abort", () =>
            resume(
              Effect.fail(
                new ThreadTriageOutboxStorageError({ cause: failure ?? transaction.error }),
              ),
            ),
          );
          run(transaction.objectStore(STORE_NAME), (cause) => {
            failure = cause;
            transaction.abort();
          });
        } catch (cause) {
          resume(Effect.fail(new ThreadTriageOutboxStorageError({ cause })));
        }
      }),
    (database) => Effect.sync(() => database.close()),
  );

const stored = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * Kept out of the environment cache so clearing cached data keeps unsynced settles and snoozes.
 * Browsers run readwrite transactions on one store in order across tabs, so concurrent changes
 * from several tabs all land, on plain HTTP as well as secure origins.
 */
export const browserThreadTriageOutboxStorage = {
  read: Effect.suspend(() => {
    let value: string | null = null;
    return transact("readonly", (store) => {
      const request = store.get(KEY);
      request.addEventListener("success", () => {
        value = stored(request.result);
      });
    }).pipe(Effect.map(() => value));
  }),
  modify: (next) =>
    transact("readwrite", (store, abort) => {
      const request = store.get(KEY);
      request.addEventListener("success", () => {
        try {
          const value = next(stored(request.result));
          if (value !== null) store.put(value, KEY);
        } catch (cause) {
          abort(cause);
        }
      });
    }),
} satisfies Parameters<typeof makeThreadTriageOutboxStore>[0];

export const browserThreadTriageOutboxStore = makeThreadTriageOutboxStore(
  browserThreadTriageOutboxStorage,
);
