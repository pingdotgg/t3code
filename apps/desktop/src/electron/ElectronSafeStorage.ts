import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

// Electron's blocking safeStorage calls run the OS credential-store lookup on the main
// thread. A locked GNOME Keyring, KWallet or KeePassXC never answers, so the main process
// stops pumping its message loop and the app shows a black, unresizable window instead of
// a UI. Electron 42 added promise-based calls that resolve off the main thread; this
// deadline is how long a caller waits on one of those before giving up on the store. It is
// long enough for someone to answer an unlock prompt, because giving up early hides the
// environments they just unlocked for. Nothing is cached, so a store unlocked after the
// deadline starts working on the next call rather than after a restart.
const SAFE_STORAGE_DEADLINE = Duration.seconds(30);

// Electron 42 answers "is the key ready" synchronously and Electron 43 answers with a
// promise, so ask the question both versions answer the same way instead: encrypting a
// throwaway string resolves exactly when the credential store has handed over the key.
const AVAILABILITY_PROBE_PLAINTEXT = "t3code-safe-storage-probe";

// Linux without a usable secret store selects `basic_text`, which "encrypts" with a
// hardcoded password. The blocking API reports that as unavailable and callers then decline
// to persist the secret at all, which is the behavior we want to keep: credentials belong
// in a real keyring or nowhere.
const UNPROTECTED_LINUX_BACKEND = "basic_text";

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedErrorClass<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedErrorClass<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedErrorClass<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;
export const isElectronSafeStorageError = Schema.is(ElectronSafeStorageError);

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/electron/ElectronSafeStorage") {}

interface AsyncSafeStorage {
  readonly encryptStringAsync: (plainText: string) => Promise<Uint8Array>;
  readonly decryptStringAsync: (encrypted: Buffer) => Promise<{ readonly result: string }>;
}

// The desktop app still builds against Electron runtimes that predate the promise-based
// calls, so detect them instead of assuming them. Drop this once the minimum Electron is 42.
export function resolveAsyncSafeStorage(candidate: unknown): Option.Option<AsyncSafeStorage> {
  if (typeof candidate !== "object" || candidate === null) {
    return Option.none();
  }
  const api = candidate as Partial<AsyncSafeStorage>;
  return typeof api.encryptStringAsync === "function" &&
    typeof api.decryptStringAsync === "function"
    ? Option.some(api as AsyncSafeStorage)
    : Option.none();
}

const deadlineCause = (operation: string): Error =>
  new Error(
    `Electron safe storage did not answer within ${Duration.toSeconds(SAFE_STORAGE_DEADLINE)} seconds while trying to ${operation}. The OS credential store is most likely locked.`,
  );

const withDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  onDeadline: () => E,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.timeoutOption(SAFE_STORAGE_DEADLINE),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(onDeadline()),
        onSome: Effect.succeed,
      }),
    ),
  );

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const asyncSafeStorage = resolveAsyncSafeStorage(Electron.safeStorage);

  const selectedStorageBackend: Effect.Effect<Option.Option<string>> = Effect.sync(() => {
    if (platform !== "linux") {
      return Option.none<string>();
    }
    try {
      return Option.fromNullishOr(Electron.safeStorage.getSelectedStorageBackend());
    } catch {
      return Option.none<string>();
    }
  });

  const encryptString = (
    value: string,
  ): Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError> =>
    Option.match(asyncSafeStorage, {
      onNone: () =>
        Effect.try({
          try: () => Electron.safeStorage.encryptString(value),
          catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
        }),
      onSome: (safeStorage) =>
        withDeadline(
          Effect.tryPromise({
            // The unused signal parameter is load-bearing: Effect only registers an
            // interrupt handler for a thunk that asks for the abort signal, and without one
            // the deadline below would wait for the credential store anyway.
            try: (_signal) => safeStorage.encryptStringAsync(value),
            catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
          }),
          () => new ElectronSafeStorageEncryptError({ cause: deadlineCause("encrypt a string") }),
        ),
    });

  const decryptString = (
    value: Uint8Array,
  ): Effect.Effect<string, ElectronSafeStorageDecryptError> =>
    Option.match(asyncSafeStorage, {
      onNone: () =>
        Effect.try({
          try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
          catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
        }),
      onSome: (safeStorage) =>
        withDeadline(
          Effect.tryPromise({
            // See encryptString: the signal parameter is what makes the deadline effective.
            try: (_signal) =>
              safeStorage
                .decryptStringAsync(Buffer.from(value))
                .then((decrypted) => decrypted.result),
            catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
          }),
          () => new ElectronSafeStorageDecryptError({ cause: deadlineCause("decrypt a string") }),
        ),
    });

  const isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError> =
    Option.match(asyncSafeStorage, {
      onNone: () =>
        Effect.try({
          try: () => Electron.safeStorage.isEncryptionAvailable(),
          catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
        }),
      onSome: () =>
        Effect.gen(function* () {
          const backend = yield* selectedStorageBackend;
          if (
            Option.match(backend, {
              onNone: () => false,
              onSome: (name) => name === UNPROTECTED_LINUX_BACKEND,
            })
          ) {
            return false;
          }

          return yield* encryptString(AVAILABILITY_PROBE_PLAINTEXT).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning(
                "Safe storage is unavailable: the OS credential store did not hand over an encryption key.",
                {
                  backend: Option.getOrElse(backend, () => "unknown"),
                  error,
                },
              ).pipe(Effect.as(false)),
            ),
          );
        }),
    });

  return ElectronSafeStorage.of({
    isEncryptionAvailable,
    encryptString,
    decryptString,
    selectedStorageBackend,
  });
});

export const layer = Layer.effect(ElectronSafeStorage, make);
