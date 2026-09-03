// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt primitives Chromium uses; Effect has no equivalent.
/**
 * Chromium cookie extraction.
 *
 * Reads a Chromium-family browser's cookie database and decrypts each record
 * with the key its prefix calls for. Key acquisition — and the consent it
 * needs — lives in `ChromiumKeys`.
 *
 * Records whose scheme we hold no key for are skipped rather than failing the
 * whole import: a Linux database can mix `v10` and `v11`. A partial result
 * reported honestly is more useful than an all-or-nothing error.
 *
 * @module ChromiumCookies
 */
import * as NodeCrypto from "node:crypto";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ChromiumKeyError,
  ChromiumKeyFailure,
  readWindowsKey,
  resolveChromiumKeys,
  type ChromiumKeyMaterial,
} from "./ChromiumKeys.ts";
import {
  bareHost,
  cookieScope,
  snapshotCookieDatabase,
  type CookieReadResult,
  type ImportedCookie,
} from "./CookieDatabase.ts";

/** OSCrypt's CBC mode uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_CBC_IV = Buffer.alloc(16, 0x20);
const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const isChromiumKeyError = Schema.is(ChromiumKeyError);

/**
 * Every way the read can fail: the key failures, plus the ones this module
 * raises itself.
 */
export const ChromiumCookieReadReason = Schema.Literals([
  // `readFailed` already comes from the key failures, so it is not repeated.
  ...ChromiumKeyFailure.literals,
  "browserRunning",
]);
export type ChromiumCookieReadReason = typeof ChromiumCookieReadReason.Type;

export class ChromiumCookieReadError extends Schema.TaggedErrorClass<ChromiumCookieReadError>()(
  "ChromiumCookieReadError",
  {
    reason: ChromiumCookieReadReason,
    /**
     * Which database the read was for. Without it every `readFailed` and
     * keychain failure logs identically, and a user with several browsers
     * installed has no way to tell which one refused.
     */
    cookieDatabasePath: Schema.String,
    /** Kept for the log; never surfaced to the user. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read Chromium cookies at ${this.cookieDatabasePath}: ${this.reason}.`;
  }
}

/** Row shape of the cookie table, decoded rather than cast. */
const CookieRow = Schema.Struct({
  host_key: Schema.String,
  name: Schema.String,
  value: Schema.String,
  encrypted_value: Schema.Uint8Array,
  path: Schema.String,
  expires_seconds: Schema.Number,
  is_secure: Schema.Number,
  is_httponly: Schema.Number,
  samesite: Schema.Number,
  top_frame_site_key: Schema.String,
});
const decodeCookieRows = Schema.decodeUnknownEffect(Schema.Array(CookieRow));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SchemaVersion = Schema.Union([
  NonNegativeInt,
  Schema.FiniteFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
]);
const decodeSchemaVersion = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ value: SchemaVersion })]),
);

/**
 * Chromium stores `SameSite` as an int: -1 = unspecified, 0 = none, 1 = lax,
 * 2 = strict. Unspecified is imported as Electron's own `unspecified` rather
 * than pinned to Lax, so the target browser applies its default just as the
 * source did; anything unrecognised lands there too, since guessing "none"
 * would widen a cookie's scope on import.
 */
const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
};

/**
 * Chromium timestamps count microseconds from 1601-01-01; Electron wants
 * seconds from the UNIX epoch. The microsecond value overflows JavaScript's
 * safe integer range and `node:sqlite` refuses to narrow it, so the division
 * happens in SQL and this only ever sees seconds.
 */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined => {
  if (webkitSeconds <= 0) return undefined;
  return webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;
};

/**
 * Chromium >= 127 prefixes the plaintext with SHA-256 of the host key, binding
 * a cookie to its domain. Strip it when present.
 */
const stripDomainBinding = (
  plaintext: Buffer,
  domain: string,
  schemaVersion: number,
): Buffer | null => {
  if (schemaVersion < 24) return plaintext;
  const domainHash = NodeCrypto.createHash("sha256").update(domain).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash)
    ? plaintext.subarray(32)
    : null;
};

const decryptCbc = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
): string | null => {
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
};

const decryptGcm = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
): string | null => {
  if (payload.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) return null;
  try {
    const nonce = payload.subarray(0, AES_GCM_NONCE_LENGTH);
    const ciphertext = payload.subarray(AES_GCM_NONCE_LENGTH, -AES_GCM_TAG_LENGTH);
    const tag = payload.subarray(-AES_GCM_TAG_LENGTH);
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
};

/**
 * Decrypts one stored value, choosing the scheme from its prefix. Returns null
 * when no key covers that scheme — including Windows' app-bound `v20`, which
 * this build has no key for at all.
 */
export function decryptChromiumValue(
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion = 23,
  platform: NodeJS.Platform = "linux",
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  const prefix = buffer.subarray(0, 3).toString("latin1");
  const payload = buffer.subarray(3);

  // Windows' legacy v10 format is AES-256-GCM. App-bound records use v20 and
  // intentionally have no key here, so they fall through as undecryptable.
  if (platform === "win32") {
    return prefix === "v10" && keys.gcmV10
      ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion)
      : null;
  }

  // Chromium retries a failed record with a key derived from an empty
  // passphrase, because some Linux clients wrote data that way
  // (crbug.com/1195256). A record whose own key is missing entirely stays
  // skipped, matching Chromium.
  if (prefix === "v10") {
    if (!keys.cbcV10) return null;
    return (
      decryptCbc(payload, keys.cbcV10, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  if (prefix === "v11") {
    if (!keys.cbcV11) return null;
    return (
      decryptCbc(payload, keys.cbcV11, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  // No recognised prefix: Chromium on macOS and Linux both treat this as
  // legacy data stored in the clear and return it as-is, so it is a readable
  // cookie rather than an undecryptable one. Windows is the exception — its
  // app-bound `v20` blobs also lack these prefixes and must not be read as
  // plaintext — but Windows Chromium is not importable here at all.
  if (platform === "darwin" || platform === "linux") {
    return stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null;
  }
  return null;
}

/** Reads and decodes one snapshotted Chromium cookie database. */
export const readChromiumCookieDatabase = Effect.fn("ChromiumCookies.readChromiumCookieDatabase")(
  function* (snapshotPath: string, keys: ChromiumKeyMaterial, platform: NodeJS.Platform) {
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schemaVersion = yield* sql`select value from meta where key = 'version' limit 1`.pipe(
        Effect.flatMap(decodeSchemaVersion),
        Effect.map(([row]) => row.value),
      );
      const raw =
        schemaVersion >= 15
          ? yield* sql`select host_key, name, value, encrypted_value, path,
                expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
                samesite, top_frame_site_key from cookies`
          : yield* sql`select host_key, name, value, encrypted_value, path,
                expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
                samesite, '' as top_frame_site_key from cookies`;
      return { rows: yield* decodeCookieRows(raw), schemaVersion };
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath, readonly: true })));

    const cookies: ImportedCookie[] = [];
    let undecryptable = 0;
    const undecryptableHosts = new Set<string>();
    for (const row of result.rows) {
      if (row.top_frame_site_key !== "") {
        undecryptable += 1;
        undecryptableHosts.add(bareHost(row.host_key));
        continue;
      }
      const value =
        row.encrypted_value.length === 0
          ? row.value
          : decryptChromiumValue(
              row.encrypted_value,
              keys,
              row.host_key,
              result.schemaVersion,
              platform,
            );
      if (value === null) {
        undecryptable += 1;
        undecryptableHosts.add(bareHost(row.host_key));
        continue;
      }
      const secure = row.is_secure === 1;
      const scope = cookieScope(row.host_key, row.path, secure);
      cookies.push({
        url: scope.url,
        name: row.name,
        value,
        domain: scope.domain,
        path: row.path,
        secure,
        httpOnly: row.is_httponly === 1,
        expirationDate: toUnixSeconds(row.expires_seconds),
        sameSite: sameSiteFromColumn(row.samesite),
      });
    }
    // Keep partial imports, but do not call a missing key a successful import
    // when it prevented every otherwise importable cookie from being read.
    if (
      cookies.length === 0 &&
      keys.cbcV11Error !== undefined &&
      result.rows.some(
        (row) =>
          row.top_frame_site_key === "" &&
          Buffer.from(row.encrypted_value.subarray(0, 3)).toString("latin1") === "v11",
      )
    ) {
      return yield* keys.cbcV11Error;
    }
    return {
      cookies,
      undecryptable,
      undecryptableHosts: [...undecryptableHosts],
    } satisfies CookieReadResult;
  },
);

export interface ChromiumCookieSource {
  readonly cookieDatabasePath: string;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly linuxSecretApplication: string | undefined;
  readonly windowsLocalStatePath?: string;
  /** Supplied by the caller from `HostProcessPlatform` rather than read here. */
  readonly platform: NodeJS.Platform;
}

export const readChromiumCookies = Effect.fn("ChromiumCookies.readChromiumCookies")(function* (
  source: ChromiumCookieSource,
): Effect.fn.Return<
  CookieReadResult,
  ChromiumCookieReadError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const keys = yield* (
    source.platform === "win32" && source.windowsLocalStatePath
      ? readWindowsKey(source.windowsLocalStatePath).pipe(Effect.map((gcmV10) => ({ gcmV10 })))
      : resolveChromiumKeys({
          platform: source.platform,
          keychainService: source.keychainService,
          keychainAccount: source.keychainAccount,
          linuxSecretApplication: source.linuxSecretApplication,
        })
  ).pipe(
    Effect.mapError(
      (cause: ChromiumKeyError) =>
        new ChromiumCookieReadError({
          reason: cause.reason,
          cookieDatabasePath: source.cookieDatabasePath,
          cause,
        }),
    ),
  );

  const snapshotPath = yield* snapshotCookieDatabase(source.cookieDatabasePath).pipe(
    Effect.mapError(
      (cause) =>
        new ChromiumCookieReadError({
          reason: "readFailed",
          cookieDatabasePath: source.cookieDatabasePath,
          cause,
        }),
    ),
  );

  return yield* readChromiumCookieDatabase(snapshotPath, keys, source.platform).pipe(
    Effect.mapError(
      (cause) =>
        new ChromiumCookieReadError({
          reason: isChromiumKeyError(cause) ? cause.reason : "readFailed",
          cookieDatabasePath: source.cookieDatabasePath,
          cause,
        }),
    ),
  );
});
