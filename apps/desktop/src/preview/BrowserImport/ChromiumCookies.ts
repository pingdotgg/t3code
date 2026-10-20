// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt primitives Chromium uses; Effect has no equivalent.
import * as NodeCrypto from "node:crypto";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";

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

export const ChromiumCookieReadReason = Schema.Literals([
  ...ChromiumKeyFailure.literals,
  "browserRunning",
]);
export type ChromiumCookieReadReason = typeof ChromiumCookieReadReason.Type;

export class ChromiumCookieReadError extends Schema.TaggedError<ChromiumCookieReadError>()(
  "ChromiumCookieReadError",
  {
    reason: ChromiumCookieReadReason,
    cookieDatabasePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read Chromium cookies at ${this.cookieDatabasePath}: ${this.reason}.`;
  }
}

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
 * Unspecified is imported as Electron's own `unspecified` rather than pinned to
 * Lax, so the target browser applies its default just as the source did;
 * anything unrecognised lands there too, since guessing "none" would widen a
 * cookie's scope on import.
 */
const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
};

/**
 * The microsecond value overflows JavaScript's safe integer range and
 * `node:sqlite` refuses to narrow it, so the division happens in SQL and this
 * only ever sees seconds.
 */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined => {
  if (webkitSeconds <= 0) return undefined;
  return webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;
};

/**
 * Chromium >= 127 prefixes the plaintext with SHA-256 of the host key, binding
 * a cookie to its domain.
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
  // (crbug.com/1195256).
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
  if (platform === "darwin" || platform === "linux") {
    return stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null;
  }
  return null;
}

export const readChromiumCookieDatabase = Effect.fn("ChromiumCookies.readChromiumCookieDatabase")(
  function* (snapshotPath: string, keys: ChromiumKeyMaterial, platform: NodeJS.Platform) {
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schemaVersion = yield* sql`select value from meta where key = 'version' limit 1`.pipe(
        Effect.flatMap(decodeSchemaVersion),
        Effect.map(([row]) => row.value),
      );
      // SQLite's BLOB affinity still permits TEXT. Cast before Node decodes
      // those bytes as UTF-8, which can corrupt an encrypted payload.
      const raw =
        schemaVersion >= 15
          ? yield* sql`select host_key, name, value, cast(encrypted_value as blob) as encrypted_value, path,
                expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
                samesite, top_frame_site_key from cookies`
          : yield* sql`select host_key, name, value, cast(encrypted_value as blob) as encrypted_value, path,
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
