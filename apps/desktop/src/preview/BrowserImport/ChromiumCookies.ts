// @effect-diagnostics nodeBuiltinImport:off
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
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch, or undefined for a session cookie. */
  readonly expirationDate: number | undefined;
  readonly sameSite: "no_restriction" | "lax" | "strict";
}

export type ChromiumCookieReadFailure =
  | { readonly reason: "needsKeychainApproval" }
  | { readonly reason: "keychainItemMissing" }
  | { readonly reason: "browserRunning" }
  | { readonly reason: "unsupportedPlatform" };

export class ChromiumCookieReadError extends Error {
  readonly failure: ChromiumCookieReadFailure;

  constructor(failure: ChromiumCookieReadFailure) {
    super(`Could not read Chromium cookies: ${failure.reason}`);
    this.name = "ChromiumCookieReadError";
    this.failure = failure;
  }
}

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
async function readMacKeychainPassword(service: string, account: string): Promise<string> {
  let password: string | null;
  try {
    password = new Keyring.Entry(service, account).getPassword();
  } catch (cause) {
    const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
    // Distinguish the causes rather than reporting "approve the prompt" for a
    // failure approving cannot fix.
    if (/no (matching )?entry|not found/i.test(message)) {
      throw new ChromiumCookieReadError({ reason: "keychainItemMissing" });
    }
    throw new ChromiumCookieReadError({ reason: "needsKeychainApproval" });
  }
  if (password === null || password === "") {
    throw new ChromiumCookieReadError({ reason: "keychainItemMissing" });
  }
  return password;
}

/**
 * Chromium keeps the cookie DB open with WAL, and reading it in place can
 * observe a torn state. Copying first — including the sidecars — gives a
 * consistent snapshot without touching the browser's own files.
 */
async function copyCookieDatabase(cookiePath: string): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-cookie-import-"));
  const target = NodePath.join(directory, "Cookies");
  await NodeFSP.copyFile(cookiePath, target);
  for (const suffix of ["-wal", "-shm"]) {
    await NodeFSP.copyFile(`${cookiePath}${suffix}`, `${target}${suffix}`).catch(() => undefined);
  }
  return {
    path: target,
    cleanup: () => NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined),
  };
}

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

export async function readChromiumCookies(
  source: ChromiumCookieSource,
): Promise<ReadonlyArray<ChromiumCookie>> {
  if (source.platform !== "darwin") {
    // Linux (libsecret) and Windows (DPAPI, and App-Bound Encryption on
    // current Chrome) each need their own key path; only macOS is implemented.
    throw new ChromiumCookieReadError({ reason: "unsupportedPlatform" });
  }

  const password = await readMacKeychainPassword(source.keychainService, source.keychainAccount);
  const key = NodeCrypto.pbkdf2Sync(
    password,
    MAC_KEY_SALT,
    MAC_KEY_ITERATIONS,
    MAC_KEY_LENGTH,
    "sha1",
  );

  const snapshot = await copyCookieDatabase(source.cookieDatabasePath);
  try {
    const database = new NodeSqlite.DatabaseSync(snapshot.path, { readOnly: true });
    try {
      const rows = database
        .prepare(
          `select host_key, name, encrypted_value, path,
                  expires_utc / 1000000 as expires_seconds,
                  is_secure, is_httponly, samesite
             from cookies`,
        )
        .all() as unknown as ReadonlyArray<{
        host_key: string;
        name: string;
        encrypted_value: Uint8Array;
        path: string;
        expires_seconds: number;
        is_secure: number;
        is_httponly: number;
        samesite: number;
      }>;

      const cookies: ChromiumCookie[] = [];
      for (const row of rows) {
        const value = decryptValue(row.encrypted_value, key, row.host_key);
        if (value === null) continue;
        const secure = row.is_secure === 1;
        // Electron matches cookies to a URL rather than a bare domain, so a
        // host-only entry keeps its leading dot stripped for the URL but not
        // for the domain it is registered under.
        const host = row.host_key.startsWith(".") ? row.host_key.slice(1) : row.host_key;
        cookies.push({
          url: `${secure ? "https" : "http"}://${host}${row.path}`,
          name: row.name,
          value,
          domain: row.host_key,
          path: row.path,
          secure,
          httpOnly: row.is_httponly === 1,
          expirationDate: toUnixSeconds(row.expires_seconds),
          sameSite: sameSiteFromColumn(row.samesite),
        });
      }
      return cookies;
    } finally {
      database.close();
    }
  } finally {
    await snapshot.cleanup();
  }
}
