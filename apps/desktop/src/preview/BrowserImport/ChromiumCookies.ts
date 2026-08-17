// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// OSCrypt primitives Chromium uses; Effect has no equivalent.
/**
 * Chromium cookie extraction.
 *
 * Reads a Chromium-family browser's cookie database and decrypts it with the
 * key the OS keychain hands us, which is the mechanism the browser itself
 * uses. macOS mediates that with a per-app consent prompt, so the user
 * explicitly approves T3 Code reading it.
 *
 * Deliberately no fallback when the keychain says no: the alternative
 * techniques exist to defeat that consent, and this feature is not worth
 * shipping them.
 *
 * @module ChromiumCookies
 */
import * as Keyring from "@napi-rs/keyring";
import * as NodeCrypto from "node:crypto";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** macOS OSCrypt parameters. Chromium has used these since the feature landed. */
const MAC_KEY_ITERATIONS = 1003;
const MAC_KEY_SALT = "saltysalt";
const MAC_KEY_LENGTH = 16;
/** OSCrypt uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_IV = Buffer.alloc(16, 0x20);
const V10_PREFIX = "v10";

export interface ChromiumCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /**
   * Set only for domain cookies, which Chromium stores with a leading dot.
   * A host-only cookie leaves this undefined: Electron treats any `domain` it
   * is given as a domain cookie and re-adds the dot, which would widen the
   * cookie to every subdomain of the host it was scoped to.
   */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch, or undefined for a session cookie. */
  readonly expirationDate: number | undefined;
  readonly sameSite: "no_restriction" | "lax" | "strict";
}

export const ChromiumCookieReadReason = Schema.Literals([
  "needsKeychainApproval",
  "keychainItemMissing",
  "browserRunning",
  "unsupportedPlatform",
  "readFailed",
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
  encrypted_value: Schema.Uint8Array,
  path: Schema.String,
  expires_seconds: Schema.Number,
  is_secure: Schema.Number,
  is_httponly: Schema.Number,
  samesite: Schema.Number,
});

const decodeCookieRows = Schema.decodeUnknownEffect(Schema.Array(CookieRow));

/**
 * Chromium stores `SameSite` as an int; unspecified (-1) behaves as Lax in
 * modern Chromium, so it maps there rather than to `no_restriction`, which
 * would widen the cookie's scope on import.
 */
const sameSiteFromColumn = (value: number): ChromiumCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 2) return "strict";
  return "lax";
};

/**
 * Chromium timestamps count microseconds from 1601-01-01; Electron wants
 * seconds from the UNIX epoch.
 *
 * The microsecond value overflows JavaScript's safe integer range, and
 * `node:sqlite` refuses to narrow it, so the division happens in SQL and this
 * only ever sees seconds.
 */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined => {
  if (webkitSeconds <= 0) return undefined;
  return webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;
};

/**
 * Reads the OSCrypt key from the login keychain.
 *
 * Uses the in-process Keychain API rather than shelling out to
 * `/usr/bin/security`, because the keychain attributes both the consent prompt
 * and the resulting ACL entry to the binary that asks. Via the CLI the prompt
 * says "security" and "Always Allow" grants trust to a tool every process on
 * the machine can invoke; in-process it names this app and the grant belongs
 * to it. (In an unsigned dev build the name is the dev Electron binary rather
 * than the shipped app identity.)
 *
 * Deliberately untimed: macOS answers this with a modal, and a timeout racing
 * the user means the prompt can be approved while nothing is left listening —
 * which reads as "approving did nothing".
 */
const readMacKeychainPassword = Effect.fn("ChromiumCookies.readMacKeychainPassword")(function* (
  service: string,
  account: string,
  cookieDatabasePath: string,
) {
  const password = yield* Effect.try({
    try: () => new Keyring.Entry(service, account).getPassword(),
    catch: (cause) => {
      const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
      // Distinguish the causes rather than telling the user to approve a
      // prompt when approving cannot fix the failure.
      const missing = /no (matching )?entry|not found/i.test(message);
      return new ChromiumCookieReadError({
        reason: missing ? "keychainItemMissing" : "needsKeychainApproval",
        cookieDatabasePath,
        cause,
      });
    },
  });
  if (password === null || password === "") {
    return yield* new ChromiumCookieReadError({
      reason: "keychainItemMissing",
      cookieDatabasePath,
    });
  }
  return password;
});

/**
 * Chromium keeps the cookie DB open with WAL, and reading it in place can
 * observe a torn state. Copying first — including the sidecars — gives a
 * consistent snapshot without touching the browser's own files.
 *
 * Scoped: the temp directory is removed when the caller's scope closes.
 */
const snapshotCookieDatabase = Effect.fn("ChromiumCookies.snapshotCookieDatabase")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-cookie-import-" });
  const target = path.join(directory, "Cookies");
  yield* fileSystem.copyFile(cookiePath, target);
  // A sidecar only exists while the browser holds the database open, so an
  // absent one is normal. Anything else — a permission error, a partial read —
  // is not: SQLite would then open the snapshot without the write-ahead log
  // and quietly return a cookie set missing its most recent transactions.
  yield* Effect.forEach(["-wal", "-shm"], (suffix) =>
    fileSystem.copyFile(`${cookiePath}${suffix}`, `${target}${suffix}`).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    ),
  );
  return target;
});

/**
 * The URL and domain Electron should register a stored row under.
 *
 * Chromium marks a domain cookie with a leading dot on `host_key`. Electron
 * matches on a URL, so the dot comes off for that; `domain` is passed through
 * only for domain cookies, because supplying it at all makes Electron treat
 * the cookie as one and re-add the dot — widening a host-only cookie to every
 * subdomain of the host it was scoped to, and rejecting `__Host-` cookies,
 * which require it to be absent.
 */
export const cookieScope = (
  hostKey: string,
  path: string,
  secure: boolean,
): { readonly url: string; readonly domain: string | undefined } => {
  const isDomainCookie = hostKey.startsWith(".");
  const host = isDomainCookie ? hostKey.slice(1) : hostKey;
  return {
    url: `${secure ? "https" : "http"}://${host}${path}`,
    ...(isDomainCookie ? { domain: hostKey } : { domain: undefined }),
  };
};

const decryptValue = (encrypted: Uint8Array, key: Buffer, domain: string): string | null => {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  if (buffer.subarray(0, 3).toString("latin1") !== V10_PREFIX) return null;

  try {
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, AES_IV);
    decipher.setAutoPadding(true);
    let plaintext = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
    // Chromium >= 127 prefixes the plaintext with SHA-256 of the host key to
    // bind a cookie to its domain; strip it when present.
    const domainHash = NodeCrypto.createHash("sha256").update(domain).digest();
    if (plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash)) {
      plaintext = plaintext.subarray(32);
    }
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
};

export interface ChromiumCookieSource {
  readonly cookieDatabasePath: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  /** Supplied by the caller from `HostProcessPlatform` rather than read here. */
  readonly platform: NodeJS.Platform;
}

export const readChromiumCookies = Effect.fn("ChromiumCookies.readChromiumCookies")(function* (
  source: ChromiumCookieSource,
) {
  if (source.platform !== "darwin") {
    // Linux (libsecret) and Windows (DPAPI, and App-Bound Encryption on
    // current Chrome) each need their own key path; only macOS is implemented.
    return yield* new ChromiumCookieReadError({
      reason: "unsupportedPlatform",
      cookieDatabasePath: source.cookieDatabasePath,
    });
  }

  const password = yield* readMacKeychainPassword(
    source.keychainService,
    source.keychainAccount,
    source.cookieDatabasePath,
  );
  const key = NodeCrypto.pbkdf2Sync(
    password,
    MAC_KEY_SALT,
    MAC_KEY_ITERATIONS,
    MAC_KEY_LENGTH,
    "sha1",
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

  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const raw = yield* sql`
      select host_key, name, encrypted_value, path,
             expires_utc / 1000000 as expires_seconds,
             is_secure, is_httponly, samesite
        from cookies
    `;
    return yield* decodeCookieRows(raw);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath, readonly: true })),
    Effect.mapError(
      (cause) =>
        new ChromiumCookieReadError({
          reason: "readFailed",
          cookieDatabasePath: source.cookieDatabasePath,
          cause,
        }),
    ),
  );

  const cookies: ChromiumCookie[] = [];
  for (const row of rows) {
    const value = decryptValue(row.encrypted_value, key, row.host_key);
    if (value === null) continue;
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
  return cookies satisfies ReadonlyArray<ChromiumCookie>;
});
