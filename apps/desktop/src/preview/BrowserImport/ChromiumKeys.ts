// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt key derivation Chromium uses; Effect has no equivalent.
/**
 * Chromium cookie-encryption keys, per platform.
 *
 * Chromium calls this OSCrypt, and it works differently on each OS:
 *
 * - **macOS** keeps one key in the login keychain. Reading it prompts the
 *   user, which is the consent this feature is built around.
 * - **Linux** may keep a key in libsecret/kwallet (`v11` records), or use a
 *   hardcoded `peanuts` passphrase when no keyring is available (`v10`).
 *   Both can appear in the same database, so both are derived up front and
 *   chosen per record.
 * - **Windows** wraps an AES-256-GCM key in DPAPI inside `Local State`. Since
 *   Chrome 127 it *also* keeps an app-bound key that only the browser binary
 *   can unwrap, and cookies written under it carry a `v20` prefix. Those are
 *   not readable by anything else, by design, and this module does not try.
 *
 * @module ChromiumKeys
 */
import * as Keyring from "@napi-rs/keyring";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const KEY_SALT = "saltysalt";
const KEY_LENGTH = 16;
/** macOS stretches the keychain secret; Linux uses a single iteration. */
const MAC_KEY_ITERATIONS = 1003;
const LINUX_KEY_ITERATIONS = 1;
/** Chromium's documented fallback passphrase when no Linux keyring is present. */
const LINUX_FALLBACK_PASSPHRASE = "peanuts";

export const ChromiumKeyFailure = Schema.Literals([
  "needsKeychainApproval",
  "keychainItemMissing",
  "appBoundEncryption",
  "unsupportedPlatform",
  /** The key store itself could not be read, as opposed to holding no key. */
  "readFailed",
]);
export type ChromiumKeyFailure = typeof ChromiumKeyFailure.Type;

export class ChromiumKeyError extends Schema.TaggedErrorClass<ChromiumKeyError>()(
  "ChromiumKeyError",
  {
    reason: ChromiumKeyFailure,
    /**
     * The metadata file the failure is about, when it is about one. Without it
     * an unreadable `Local State` is reported against the cookie database the
     * caller names instead.
     */
    localStatePath: Schema.optional(Schema.String),
    /** Exit status of the helper that was asked to unwrap the key. */
    exitCode: Schema.optional(Schema.Number),
    /** Kept for the log; never surfaced to the user. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const where = this.localStatePath === undefined ? "" : ` at ${this.localStatePath}`;
    const status = this.exitCode === undefined ? "" : ` (helper exited with ${this.exitCode})`;
    return `Could not obtain the Chromium cookie key${where}: ${this.reason}${status}.`;
  }
}

/**
 * Keys to try, indexed by the record prefix they decrypt. A database can hold
 * records written under more than one scheme, so a missing entry means those
 * records are skipped rather than the whole import failing.
 */
export interface ChromiumKeyMaterial {
  /** AES-128-CBC on macOS and Linux. */
  readonly cbcV10?: Buffer;
  /** AES-128-CBC, Linux keyring-derived. */
  readonly cbcV11?: Buffer;
  /** AES-256-GCM on Windows. */
  readonly gcmV10?: Buffer;
}

const isChromiumKeyError = Schema.is(ChromiumKeyError);

const derive = (passphrase: string, iterations: number) =>
  NodeCrypto.pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, "sha1");

/**
 * Reads the OSCrypt key from the macOS login keychain.
 *
 * Uses the in-process Keychain API rather than shelling out to
 * `/usr/bin/security`, because macOS attributes both the consent prompt and
 * the resulting ACL entry to the binary that asks. Via the CLI the prompt says
 * "security" and "Always Allow" grants trust to a tool every process on the
 * machine can invoke; in-process it names this app and the grant belongs to
 * it. (In an unsigned dev build the name is the dev binary, not the shipped
 * app identity.)
 *
 * Deliberately untimed: macOS answers this with a modal, and a timeout racing
 * the user means the prompt can be approved while nothing is left listening,
 * which reads as "approving did nothing".
 */
const readKeychainSecret = Effect.fn("ChromiumKeys.readKeychainSecret")(function* (
  service: string,
  account: string,
) {
  const secret = yield* Effect.try({
    try: () => new Keyring.Entry(service, account).getPassword(),
    catch: (cause) => {
      const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
      // Distinguish the causes rather than reporting "approve the prompt" for
      // a failure approving cannot fix.
      const missing = /no (matching )?entry|not found/i.test(message);
      return new ChromiumKeyError({
        reason: missing ? "keychainItemMissing" : "needsKeychainApproval",
        cause,
      });
    },
  });
  if (secret === null || secret === "") {
    return yield* new ChromiumKeyError({ reason: "keychainItemMissing" });
  }
  return secret;
});

/**
 * Unwraps the Windows DPAPI-protected key via PowerShell.
 *
 * Shelling out is fine here in a way it is not on macOS: DPAPI is transparent
 * to any process running as the user, so there is no consent prompt to
 * misattribute and no ACL entry to write against the wrong binary.
 */
const unprotectWithDpapi = Effect.fn("ChromiumKeys.unprotectWithDpapi")(function* (
  protectedKey: Buffer,
) {
  const script = [
    "Add-Type -AssemblyName System.Security;",
    `$b=[Convert]::FromBase64String('${protectedKey.toString("base64")}');`,
    "$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,",
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($u)",
  ].join("");

  const process = yield* ChildProcess.make("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  const stdout = yield* process.stdout.pipe(Stream.decodeText(), Stream.mkString);
  const exitCode = yield* process.exitCode;

  // A failed `Unprotect` still exits, printing nothing. Without these checks
  // the empty stdout decodes to a zero-length Buffer, which is truthy, so
  // `gcmV10` would be populated with an unusable key: every record then fails
  // to decrypt and the import reports success having written nothing.
  if (exitCode !== 0) {
    return yield* new ChromiumKeyError({ reason: "readFailed", exitCode });
  }
  const unwrapped = Buffer.from(stdout.trim(), "base64");
  if (unwrapped.length === 0) {
    return yield* new ChromiumKeyError({ reason: "readFailed", exitCode });
  }
  return unwrapped;
});

/** The slice of `Local State` that carries the wrapped keys. */
const LocalState = Schema.Struct({
  os_crypt: Schema.optional(
    Schema.Struct({
      encrypted_key: Schema.optional(Schema.String),
      app_bound_encrypted_key: Schema.optional(Schema.String),
    }),
  ),
});
const decodeLocalState = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalState));

/**
 * Reads the metadata file that carries the wrapped Windows keys.
 *
 * Failures are reported rather than flattened into an empty document: a
 * missing, unreadable or corrupt `Local State` is a different problem from a
 * browser that has no key yet, and telling the user the latter sends them
 * looking in the wrong place.
 */
const readLocalState = Effect.fn("ChromiumKeys.readLocalState")(function* (localStatePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(localStatePath).pipe(
    Effect.flatMap(decodeLocalState),
    Effect.mapError(
      (cause) => new ChromiumKeyError({ reason: "readFailed", localStatePath, cause }),
    ),
  );
});

/**
 * Windows stores the key base64-encoded with a literal `DPAPI` marker in
 * front, which has to come off before unwrapping.
 */
const DPAPI_MARKER = "DPAPI";

export function stripDpapiMarker(encodedKey: string): Buffer {
  const raw = Buffer.from(encodedKey, "base64");
  return raw.subarray(0, DPAPI_MARKER.length).toString("latin1") === DPAPI_MARKER
    ? raw.subarray(DPAPI_MARKER.length)
    : raw;
}

export interface ChromiumKeyRequest {
  readonly platform: NodeJS.Platform;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly localStatePath: string;
}

export const resolveChromiumKeys = Effect.fn("ChromiumKeys.resolveChromiumKeys")(function* (
  request: ChromiumKeyRequest,
): Effect.fn.Return<
  ChromiumKeyMaterial,
  ChromiumKeyError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  if (request.platform === "darwin") {
    if (!request.keychainService || !request.keychainAccount) {
      return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
    }
    const secret = yield* readKeychainSecret(request.keychainService, request.keychainAccount);
    return { cbcV10: derive(secret, MAC_KEY_ITERATIONS) };
  }

  if (request.platform === "linux") {
    // The fallback passphrase always applies to `v10` records; a keyring
    // secret, when one is reachable, additionally unlocks `v11`. Failing to
    // reach the keyring is not fatal — it just leaves those records skipped.
    const keyringSecret =
      request.keychainService && request.keychainAccount
        ? yield* readKeychainSecret(request.keychainService, request.keychainAccount).pipe(
            // No Secret Service, locked keyring, or a differently-keyed entry.
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    return {
      cbcV10: derive(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      ...(keyringSecret ? { cbcV11: derive(keyringSecret, LINUX_KEY_ITERATIONS) } : {}),
    };
  }

  if (request.platform === "win32") {
    const localState = yield* readLocalState(request.localStatePath);
    const encodedKey = localState.os_crypt?.encrypted_key;
    if (!encodedKey) {
      // An app-bound key with no legacy key means every record is `v20`.
      return yield* new ChromiumKeyError({
        reason: localState.os_crypt?.app_bound_encrypted_key
          ? "appBoundEncryption"
          : "keychainItemMissing",
      });
    }
    const unwrapped = yield* unprotectWithDpapi(stripDpapiMarker(encodedKey)).pipe(
      // Scoped here so the PowerShell process is reaped before we return.
      Effect.scoped,
      // A `ChromiumKeyError` already says what went wrong and passes through.
      // Only a spawn failure — no `powershell.exe`, or one that cannot be
      // launched — arrives as something else, and that is a read failure, not
      // a browser that has no key.
      Effect.catchIf(
        (error) => !isChromiumKeyError(error),
        (cause) => new ChromiumKeyError({ reason: "readFailed", cause }),
      ),
    );
    return { gcmV10: unwrapped };
  }

  return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
});
