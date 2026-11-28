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
  type KeychainCredentialCandidate,
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

/** Preserve unspecified SameSite; guessing no_restriction would widen cookie scope. */
const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
};

/** Convert microseconds in SQL: node:sqlite refuses integers beyond JavaScript's safe range. */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined => {
  if (webkitSeconds <= 0) return undefined;
  return webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;
};

// Chromium 127+ prefixes plaintext with the host-key SHA-256 to bind its domain.
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

const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });

// Used only when ranking candidate keys on pre-schema-24 jars that lack a SHA-256 domain-binding hash.
const isPlausibleLegacyCookie = (plaintext: Buffer): boolean => {
  try {
    const text = utf8StrictDecoder.decode(plaintext);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
    }
    return true;
  } catch {
    return false;
  }
};

const decryptCbc = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
  rejectImplausibleLegacy = false,
): string | null => {
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    const stripped = stripDomainBinding(plaintext, domain, schemaVersion);
    if (stripped === null) return null;
    if (schemaVersion < 24 && rejectImplausibleLegacy && !isPlausibleLegacyCookie(stripped)) {
      return null;
    }
    return stripped.toString("utf8");
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

const decryptChromiumValueWithOrigin = (
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion: number,
  platform: NodeJS.Platform,
  rejectImplausibleLegacy = false,
): { readonly value: string | null; readonly keyringVerified: boolean } => {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return { value: "", keyringVerified: false };
  const prefix = buffer.subarray(0, 3).toString("latin1");
  const payload = buffer.subarray(3);

  // Windows v10 uses AES-256-GCM; app-bound v20 records have no key here.
  if (platform === "win32") {
    return {
      value:
        prefix === "v10" && keys.gcmV10
          ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion)
          : null,
      keyringVerified: false,
    };
  }

  // Retry the empty-passphrase key used by some Linux clients (crbug.com/1195256).
  if (prefix === "v10") {
    if (!keys.cbcV10) return { value: null, keyringVerified: false };
    const primary = decryptCbc(
      payload,
      keys.cbcV10,
      domain,
      schemaVersion,
      platform === "darwin" && rejectImplausibleLegacy,
    );
    if (primary !== null) return { value: primary, keyringVerified: platform === "darwin" };
    const empty = keys.cbcEmpty
      ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion, rejectImplausibleLegacy)
      : null;
    return { value: empty, keyringVerified: false };
  }
  if (prefix === "v11") {
    if (!keys.cbcV11) return { value: null, keyringVerified: false };
    const primary = decryptCbc(
      payload,
      keys.cbcV11,
      domain,
      schemaVersion,
      platform === "linux" && rejectImplausibleLegacy,
    );
    if (primary !== null) return { value: primary, keyringVerified: platform === "linux" };
    const empty = keys.cbcEmpty
      ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion, rejectImplausibleLegacy)
      : null;
    return { value: empty, keyringVerified: false };
  }
  if (platform === "darwin" || platform === "linux") {
    return {
      value: stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null,
      keyringVerified: false,
    };
  }
  return { value: null, keyringVerified: false };
};

export function decryptChromiumValue(
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion = 23,
  platform: NodeJS.Platform = "linux",
): string | null {
  return decryptChromiumValueWithOrigin(encrypted, keys, domain, schemaVersion, platform).value;
}

const readRawChromiumCookieDatabase = Effect.fnUntraced(function* (snapshotPath: string) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Chromium razes a damaged jar to a file with no tables and rebuilds it on its next write.
    const tables =
      yield* sql`select 1 from sqlite_master where type = 'table' and name = 'cookies'`;
    if (tables.length === 0) {
      return { rows: [] as ReadonlyArray<typeof CookieRow.Type>, schemaVersion: 0 };
    }
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
});

interface EvaluatedCookieRows {
  readonly result: CookieReadResult;
  readonly keyringVerified: number;
  readonly keyringFailed: number;
  readonly hasV11: boolean;
}

const decryptChromiumCookieRows = (
  rows: ReadonlyArray<typeof CookieRow.Type>,
  schemaVersion: number,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
  rejectImplausibleLegacy = false,
): EvaluatedCookieRows => {
  const cookies: ImportedCookie[] = [];
  let undecryptable = 0;
  let keyringVerified = 0;
  let keyringFailed = 0;
  let hasV11 = false;
  const undecryptableHosts = new Set<string>();
  const keyringPrefix = platform === "darwin" ? "v10" : platform === "linux" ? "v11" : undefined;

  for (const row of rows) {
    if (row.top_frame_site_key !== "") {
      undecryptable += 1;
      undecryptableHosts.add(bareHost(row.host_key));
      continue;
    }
    const prefix =
      row.encrypted_value.length >= 3
        ? Buffer.from(row.encrypted_value.subarray(0, 3)).toString("latin1")
        : undefined;
    if (prefix === "v11") hasV11 = true;
    const usesKeyring = keyringPrefix !== undefined && prefix === keyringPrefix;
    const decrypted =
      row.encrypted_value.length === 0
        ? { value: row.value, keyringVerified: false }
        : decryptChromiumValueWithOrigin(
            row.encrypted_value,
            keys,
            row.host_key,
            schemaVersion,
            platform,
            rejectImplausibleLegacy,
          );
    if (decrypted.value === null) {
      undecryptable += 1;
      if (usesKeyring) keyringFailed += 1;
      undecryptableHosts.add(bareHost(row.host_key));
      continue;
    }
    if (decrypted.keyringVerified) keyringVerified += 1;
    const secure = row.is_secure === 1;
    const scope = cookieScope(row.host_key, row.path, secure);
    cookies.push({
      url: scope.url,
      name: row.name,
      value: decrypted.value,
      domain: scope.domain,
      path: row.path,
      secure,
      httpOnly: row.is_httponly === 1,
      expirationDate: toUnixSeconds(row.expires_seconds),
      sameSite: sameSiteFromColumn(row.samesite),
    });
  }

  return {
    result: {
      cookies,
      undecryptable,
      undecryptableHosts: [...undecryptableHosts],
    },
    keyringVerified,
    keyringFailed,
    hasV11,
  };
};

export const readChromiumCookieDatabase = Effect.fn("ChromiumCookies.readChromiumCookieDatabase")(
  function* (snapshotPath: string, keys: ChromiumKeyMaterial, platform: NodeJS.Platform) {
    const raw = yield* readRawChromiumCookieDatabase(snapshotPath);
    const evaluated = decryptChromiumCookieRows(raw.rows, raw.schemaVersion, keys, platform);
    if (
      evaluated.result.cookies.length === 0 &&
      keys.cbcV11Error !== undefined &&
      evaluated.hasV11
    ) {
      return yield* keys.cbcV11Error;
    }
    return evaluated.result;
  },
);

export interface ChromiumCookieSource {
  readonly cookieDatabasePath: string;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly keychainCandidates?: ReadonlyArray<KeychainCredentialCandidate> | undefined;
  readonly linuxSecretApplication: string | undefined;
  readonly linuxSecretApplications?: ReadonlyArray<string> | undefined;
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
  let cachedRaw:
    | { readonly rows: ReadonlyArray<typeof CookieRow.Type>; readonly schemaVersion: number }
    | undefined;
  let cachedEvaluation:
    | { readonly keys: ChromiumKeyMaterial; readonly evaluated: EvaluatedCookieRows }
    | undefined;

  const rejectImplausibleLegacy =
    source.platform === "darwin"
      ? (source.keychainCandidates?.length ?? 0) > 1
      : source.platform === "linux"
        ? (source.linuxSecretApplications?.length ?? 0) > 1
        : false;

  const evaluateWith = Effect.fnUntraced(
    function* (keys: ChromiumKeyMaterial) {
      if (cachedEvaluation?.keys === keys) return cachedEvaluation.evaluated;
      if (cachedRaw === undefined) {
        const snapshotPath = yield* snapshotCookieDatabase(source.cookieDatabasePath);
        cachedRaw = yield* readRawChromiumCookieDatabase(snapshotPath);
      }
      const evaluated = decryptChromiumCookieRows(
        cachedRaw.rows,
        cachedRaw.schemaVersion,
        keys,
        source.platform,
        rejectImplausibleLegacy,
      );
      cachedEvaluation = { keys, evaluated };
      return evaluated;
    },
    Effect.mapError(
      (cause) =>
        new ChromiumCookieReadError({
          reason: "readFailed",
          cookieDatabasePath: source.cookieDatabasePath,
          cause,
        }),
    ),
  );

  const keys = yield* (
    source.platform === "win32" && source.windowsLocalStatePath
      ? readWindowsKey(source.windowsLocalStatePath).pipe(
          Effect.map((gcmV10): ChromiumKeyMaterial => ({ gcmV10 })),
        )
      : resolveChromiumKeys(source, (candidateKeys) =>
          evaluateWith(candidateKeys).pipe(
            Effect.map((ev) => ({
              accepted: ev.keyringFailed === 0,
              score: ev.keyringVerified * 1_000_000 - ev.keyringFailed,
            })),
          ),
        )
  ).pipe(
    Effect.mapError((cause) =>
      isChromiumKeyError(cause)
        ? new ChromiumCookieReadError({
            reason: cause.reason,
            cookieDatabasePath: source.cookieDatabasePath,
            cause,
          })
        : cause,
    ),
  );

  const evaluated = yield* evaluateWith(keys);
  if (evaluated.result.cookies.length === 0 && keys.cbcV11Error !== undefined && evaluated.hasV11) {
    return yield* new ChromiumCookieReadError({
      reason: keys.cbcV11Error.reason,
      cookieDatabasePath: source.cookieDatabasePath,
      cause: keys.cbcV11Error,
    });
  }
  return evaluated.result;
});
