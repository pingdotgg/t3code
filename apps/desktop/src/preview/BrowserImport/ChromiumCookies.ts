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
  resolveLinuxApplicationKeys,
  resolveMacKeychainKey,
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

const decryptChromiumValueWithOrigin = (
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion: number,
  platform: NodeJS.Platform,
): { readonly value: string | null; readonly matchedKeyringKey: boolean } => {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return { value: "", matchedKeyringKey: false };
  const prefix = buffer.subarray(0, 3).toString("latin1");
  const payload = buffer.subarray(3);

  // Windows v10 uses AES-256-GCM; app-bound v20 records have no key here.
  if (platform === "win32") {
    return {
      value:
        prefix === "v10" && keys.gcmV10
          ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion)
          : null,
      matchedKeyringKey: false,
    };
  }

  // Retry the empty-passphrase key used by some Linux clients (crbug.com/1195256).
  if (prefix === "v10") {
    if (!keys.cbcV10) return { value: null, matchedKeyringKey: false };
    const primary = decryptCbc(payload, keys.cbcV10, domain, schemaVersion);
    if (primary !== null) return { value: primary, matchedKeyringKey: platform === "darwin" };
    const empty = keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null;
    return { value: empty, matchedKeyringKey: false };
  }
  if (prefix === "v11") {
    if (!keys.cbcV11) return { value: null, matchedKeyringKey: false };
    const primary = decryptCbc(payload, keys.cbcV11, domain, schemaVersion);
    if (primary !== null) return { value: primary, matchedKeyringKey: platform === "linux" };
    const empty = keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null;
    return { value: empty, matchedKeyringKey: false };
  }
  if (platform === "darwin" || platform === "linux") {
    return {
      value: stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null,
      matchedKeyringKey: false,
    };
  }
  return { value: null, matchedKeyringKey: false };
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
  readonly keyringDecrypted: number;
  readonly keyringFailed: number;
  readonly hasV11: boolean;
}

const decryptChromiumCookieRows = (
  rows: ReadonlyArray<typeof CookieRow.Type>,
  schemaVersion: number,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
): EvaluatedCookieRows => {
  const cookies: ImportedCookie[] = [];
  let undecryptable = 0;
  let keyringDecrypted = 0;
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
        ? { value: row.value, matchedKeyringKey: false }
        : decryptChromiumValueWithOrigin(
            row.encrypted_value,
            keys,
            row.host_key,
            schemaVersion,
            platform,
          );
    if (decrypted.value === null) {
      undecryptable += 1;
      if (usesKeyring) keyringFailed += 1;
      undecryptableHosts.add(bareHost(row.host_key));
      continue;
    }
    if (decrypted.matchedKeyringKey) keyringDecrypted += 1;
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
    keyringDecrypted,
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
  const wrapKeyError = (cause: ChromiumKeyError) =>
    new ChromiumCookieReadError({
      reason: cause.reason,
      cookieDatabasePath: source.cookieDatabasePath,
      cause,
    });

  let cachedRaw:
    | { readonly rows: ReadonlyArray<typeof CookieRow.Type>; readonly schemaVersion: number }
    | undefined;
  const loadRawDatabase = Effect.fnUntraced(
    function* () {
      if (cachedRaw !== undefined) return cachedRaw;
      const snapshotPath = yield* snapshotCookieDatabase(source.cookieDatabasePath);
      cachedRaw = yield* readRawChromiumCookieDatabase(snapshotPath);
      return cachedRaw;
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

  if (source.platform === "win32" && source.windowsLocalStatePath) {
    const gcmV10 = yield* readWindowsKey(source.windowsLocalStatePath).pipe(
      Effect.mapError(wrapKeyError),
    );
    const raw = yield* loadRawDatabase();
    return decryptChromiumCookieRows(raw.rows, raw.schemaVersion, { gcmV10 }, source.platform)
      .result;
  }

  if (source.platform === "darwin") {
    const candidates: ReadonlyArray<KeychainCredentialCandidate> =
      source.keychainCandidates && source.keychainCandidates.length > 0
        ? source.keychainCandidates
        : source.keychainService && source.keychainAccount
          ? [{ service: source.keychainService, account: source.keychainAccount }]
          : [];
    if (candidates.length === 0) {
      return yield* wrapKeyError(new ChromiumKeyError({ reason: "unsupportedPlatform" }));
    }
    let missingError: ChromiumKeyError | undefined;
    let firstResult: CookieReadResult | undefined;
    for (const candidate of candidates) {
      const attempt = yield* resolveMacKeychainKey(candidate).pipe(
        Effect.catchIf(
          (error) => error.reason === "keychainItemMissing",
          (error) => Effect.succeed(error),
        ),
        Effect.mapError(wrapKeyError),
      );
      if (isChromiumKeyError(attempt)) {
        missingError = attempt;
        continue;
      }
      const raw = yield* loadRawDatabase();
      const evaluated = decryptChromiumCookieRows(
        raw.rows,
        raw.schemaVersion,
        attempt,
        source.platform,
      );
      firstResult ??= evaluated.result;
      // Accept the first credential that unlocks keyring-encrypted cookies (or when none exist);
      // otherwise keep trying fallback candidates in case an earlier keychain item is stale.
      if (evaluated.keyringFailed === 0 || evaluated.keyringDecrypted > 0) {
        return evaluated.result;
      }
    }
    if (firstResult !== undefined) return firstResult;
    return yield* wrapKeyError(
      missingError ?? new ChromiumKeyError({ reason: "keychainItemMissing" }),
    );
  }

  if (source.platform === "linux") {
    const applications: ReadonlyArray<string> =
      source.linuxSecretApplications && source.linuxSecretApplications.length > 0
        ? source.linuxSecretApplications
        : source.linuxSecretApplication
          ? [source.linuxSecretApplication]
          : [];
    if (applications.length === 0) {
      const keys = yield* resolveLinuxApplicationKeys(undefined).pipe(
        Effect.mapError(wrapKeyError),
      );
      const raw = yield* loadRawDatabase();
      return decryptChromiumCookieRows(raw.rows, raw.schemaVersion, keys, source.platform).result;
    }

    let firstResult: CookieReadResult | undefined;
    let lastErrorKeys: ChromiumKeyMaterial | undefined;
    for (const application of applications) {
      const keys = yield* resolveLinuxApplicationKeys(application).pipe(
        Effect.mapError(wrapKeyError),
      );
      if (keys.cbcV11 === undefined) {
        lastErrorKeys = keys;
        if (keys.cbcV11Error?.reason === "keychainItemMissing") continue;
        break;
      }
      const raw = yield* loadRawDatabase();
      const evaluated = decryptChromiumCookieRows(
        raw.rows,
        raw.schemaVersion,
        keys,
        source.platform,
      );
      firstResult ??= evaluated.result;
      if (evaluated.keyringFailed === 0 || evaluated.keyringDecrypted > 0) {
        return evaluated.result;
      }
    }
    if (firstResult !== undefined) return firstResult;
    const fallbackKeys =
      lastErrorKeys ??
      (yield* resolveLinuxApplicationKeys(undefined).pipe(Effect.mapError(wrapKeyError)));
    const raw = yield* loadRawDatabase();
    const evaluated = decryptChromiumCookieRows(
      raw.rows,
      raw.schemaVersion,
      fallbackKeys,
      source.platform,
    );
    if (
      evaluated.result.cookies.length === 0 &&
      fallbackKeys.cbcV11Error !== undefined &&
      evaluated.hasV11
    ) {
      return yield* wrapKeyError(fallbackKeys.cbcV11Error);
    }
    return evaluated.result;
  }

  return yield* wrapKeyError(new ChromiumKeyError({ reason: "unsupportedPlatform" }));
});
