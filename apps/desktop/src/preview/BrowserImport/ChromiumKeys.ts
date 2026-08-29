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
 *   hardcoded `peanuts` passphrase when no keyring is available (`v10`). Both
 *   can appear in the same database, so both are derived up front and chosen
 *   per record.
 *
 * Windows is not supported: since Chrome 127 its cookies are encrypted to the
 * browser's own identity (App-Bound Encryption), unreadable by any other app.
 *
 * @module ChromiumKeys
 */
import * as Keyring from "@napi-rs/keyring";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
  "unsupportedPlatform",
  /** The key store itself could not be read, as opposed to holding no key. */
  "readFailed",
]);
export type ChromiumKeyFailure = typeof ChromiumKeyFailure.Type;

export class ChromiumKeyError extends Schema.TaggedErrorClass<ChromiumKeyError>()(
  "ChromiumKeyError",
  {
    reason: ChromiumKeyFailure,
    /** Kept for the log; never surfaced to the user. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not obtain the Chromium cookie key: ${this.reason}.`;
  }
}

/**
 * Keys to try, indexed by the record prefix they decrypt. A database can hold
 * records written under more than one scheme, so a missing entry means those
 * records are skipped rather than the whole import failing.
 */
export interface ChromiumKeyMaterial {
  /** AES-128-CBC on macOS, and the keyring-free Linux fallback. */
  readonly cbcV10?: Buffer;
  /** AES-128-CBC, Linux keyring-derived. */
  readonly cbcV11?: Buffer;
}

const derive = (passphrase: string, iterations: number) =>
  NodeCrypto.pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, "sha1");

/**
 * Reads the macOS OSCrypt secret from the login keychain.
 *
 * Uses the in-process Keychain API rather than shelling out to
 * `/usr/bin/security`, because macOS attributes both the consent prompt and the
 * resulting ACL entry to the binary that asks. Via the CLI the prompt says
 * "security" and "Always Allow" grants trust to a tool every process on the
 * machine can invoke; in-process it names this app and the grant belongs to it.
 * (In an unsigned dev build the name is the dev binary, not the shipped app
 * identity.)
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

const secretToolFailure = (stderr: string): ChromiumKeyFailure => {
  if (stderr.trim() === "" || /no such secret|not found/i.test(stderr)) {
    return "keychainItemMissing";
  }
  if (/denied|locked|cancel|dismiss|permission/i.test(stderr)) {
    return "needsKeychainApproval";
  }
  return "readFailed";
};

/**
 * Chromium's Linux backend uses a custom libsecret schema keyed by its
 * `application` attribute. `secret-tool lookup` performs that same attribute
 * search through Secret Service and keeps its normal unlock/consent prompt.
 */
export const readLinuxSecret = Effect.fn("ChromiumKeys.readLinuxSecret")(function* (
  application: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(
          ChildProcess.make("secret-tool", ["lookup", "application", application], {
            stdin: "ignore",
          }),
        )
        .pipe(Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })));
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ]).pipe(Effect.mapError((cause) => new ChromiumKeyError({ reason: "readFailed", cause })));
      const secret = stdout.trimEnd();
      if (Number(exitCode) !== 0) {
        return yield* new ChromiumKeyError({ reason: secretToolFailure(stderr) });
      }
      if (secret === "") {
        return yield* new ChromiumKeyError({ reason: "keychainItemMissing" });
      }
      return secret;
    }),
  );
});

export interface ChromiumKeyRequest {
  readonly platform: NodeJS.Platform;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly linuxSecretApplication: string | undefined;
}

export const resolveChromiumKeys = Effect.fn("ChromiumKeys.resolveChromiumKeys")(function* (
  request: ChromiumKeyRequest,
): Effect.fn.Return<
  ChromiumKeyMaterial,
  ChromiumKeyError,
  ChildProcessSpawner.ChildProcessSpawner
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
    const keyringSecret = request.linuxSecretApplication
      ? yield* readLinuxSecret(request.linuxSecretApplication).pipe(
          // v10 remains importable when Secret Service is absent, locked, or
          // does not contain a key for this browser.
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    return {
      cbcV10: derive(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      ...(keyringSecret ? { cbcV11: derive(keyringSecret, LINUX_KEY_ITERATIONS) } : {}),
    };
  }

  return yield* new ChromiumKeyError({ reason: "unsupportedPlatform" });
});
