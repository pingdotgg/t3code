/**
 * Safari cookie extraction.
 *
 * Safari does not encrypt its cookies; it stores them in a proprietary
 * `Cookies.binarycookies` file inside its app container. The protection is
 * TCC, not cryptography — the file lives under a path only apps with Full Disk
 * Access may read, so the gate is a permission the user grants in System
 * Settings rather than a key to obtain.
 *
 * The format, big-endian throughout except the page bodies:
 *
 *   magic "cook", u32 pageCount, u32 pageSize[pageCount], then each page:
 *     u32 0x00000100, u32le cookieCount, u32le cookieOffset[cookieCount],
 *     then each cookie:
 *       u32le size, u32le unknown, u32le flags, u32le unknown,
 *       u32le urlOffset, nameOffset, pathOffset, valueOffset,
 *       u64 end-of-header, f64 expiry, f64 creation, then NUL-terminated
 *       strings at the offsets above (relative to the cookie start).
 *
 * @module SafariCookies
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { cookieScope, type ImportedCookie } from "./CookieDatabase.ts";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** `u32 0x00000100`, `u32le cookieCount`, then one `u32le` offset per cookie. */
const COOKIE_PAGE_HEADER_SIZE = 12;
/** Through the `f64 creation` field; string bytes follow. */
const COOKIE_RECORD_HEADER_SIZE = 56;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export const SafariCookieReadFailure = Schema.Literals(["needsFullDiskAccess", "readFailed"]);
export type SafariCookieReadFailure = typeof SafariCookieReadFailure.Type;

export class SafariCookieReadError extends Schema.TaggedErrorClass<SafariCookieReadError>()(
  "SafariCookieReadError",
  {
    reason: SafariCookieReadFailure,
    /**
     * Which jar the read was for. The parser raises this before a path is in
     * hand, so it is optional rather than required.
     */
    cookieDatabasePath: Schema.optional(Schema.String),
    /** Kept for the log; never surfaced to the user. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.cookieDatabasePath === undefined
      ? `Could not read Safari cookies: ${this.reason}.`
      : `Could not read Safari cookies at ${this.cookieDatabasePath}: ${this.reason}.`;
  }
}

const isSafariCookieReadError = Schema.is(SafariCookieReadError);

/** Reads a NUL-terminated ASCII string at an offset. */
function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

export function parseBinaryCookies(buffer: Buffer): ReadonlyArray<ImportedCookie> {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }

  const pageCount = buffer.readUInt32BE(4);
  // Every declared structure is bounds-checked against what the file actually
  // contains, and a mismatch fails the read. `Buffer.subarray` clamps silently,
  // so accepting a short page or an overlong record would return a cookie set
  // that is quietly missing entries or carrying fields read out of the next
  // record — a partial import the user has no way to notice.
  if (8 + pageCount * 4 > buffer.length) {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) {
      throw new SafariCookieReadError({ reason: "readFailed" });
    }
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) {
      throw new SafariCookieReadError({ reason: "readFailed" });
    }
    // Every record accepted so far, so a later offset cannot point back into
    // one of them: the page header, the offset table, and earlier records are
    // all bytes that would otherwise parse as a fabricated cookie.
    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) {
        throw new SafariCookieReadError({ reason: "readFailed" });
      }
      // Bounded by the record's own length so a string offset cannot run past
      // it into the following record's bytes.
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (
        recordSize < COOKIE_RECORD_HEADER_SIZE ||
        cookieEnd > page.length ||
        accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)
      ) {
        throw new SafariCookieReadError({ reason: "readFailed" });
      }
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      // Offsets are relative to the record; one pointing outside it would
      // otherwise read a neighbouring cookie's bytes as this one's value.
      if (
        [urlOffset, nameOffset, pathOffset, valueOffset].some(
          (offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length,
        )
      ) {
        throw new SafariCookieReadError({ reason: "readFailed" });
      }
      const domain = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const path = readCString(cookie, pathOffset);
      const value = readCString(cookie, valueOffset);
      if (domain === "" || name === "") continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      const expirationDate =
        expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined;

      cookies.push({
        // Safari marks domain cookies with a leading dot like the other
        // engines, so the shared scope rule applies: host-only cookies keep
        // `domain` undefined, or Electron widens them to every subdomain.
        ...cookieScope(domain, path || "/", secure),
        name,
        value,
        path: path || "/",
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expirationDate,
        // Bits 3–5 of the flags carry something SameSite-shaped, but no public
        // description of them agrees and real jars do not match any of them
        // cleanly. Lax is the modern browser default; claiming "none" would
        // widen every imported cookie's scope.
        sameSite: "lax",
      });
    }
  }

  // Safari writes an 8-byte checksum after the pages, then an optional
  // length-prefixed property list. Anything else past the declared pages —
  // in particular whole extra pages — means the page table does not describe
  // the file, and a jar the header lies about is refused rather than
  // imported with cookies silently missing.
  const trailer = buffer.length - pageStart;
  // Legal shapes: nothing, the 8-byte checksum alone, or checksum + u32
  // length + exactly that many property-list bytes.
  const validTrailer =
    trailer === 0 ||
    trailer === 8 ||
    (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }

  return cookies;
}

/**
 * Whether a filesystem error is the OS refusing access.
 *
 * A TCC denial arrives as EPERM, which Effect tags `Unknown` rather than
 * `PermissionDenied` (reserved for EACCES), so the underlying errno is checked
 * too — otherwise a Full Disk Access refusal is reported as a generic read
 * failure and the user is never told what to grant.
 */
export const isPermissionDenied = (error: PlatformError.PlatformError): boolean => {
  // TCC denies with EPERM, which Effect tags `Unknown` rather than
  // `PermissionDenied` — so the errno is what identifies it. EACCES (and the
  // `PermissionDenied` tag it maps to) is an ordinary POSIX permission or
  // ACL failure that granting Full Disk Access cannot fix, so it stays a plain
  // read failure rather than sending the user to a grant that won't help.
  const code = (error.reason as { cause?: { code?: unknown } }).cause?.code;
  return code === "EPERM";
};

/**
 * Whether reading the jar is refused by TCC. `stat` succeeds on the jar
 * inside Safari's container even without Full Disk Access — that is what lets
 * the listing find it — so presence alone cannot tell granted from denied.
 * Opening it for read is what TCC gates: EPERM means the grant is missing.
 * Anything else (including a missing jar) is not a permission answer.
 */
export const safariAccessDenied = Effect.fnUntraced(function* (cookiePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(cookiePath, { flag: "r" }).pipe(
    Effect.as(false),
    Effect.catch((cause) => Effect.succeed(isPermissionDenied(cause))),
    Effect.scoped,
  );
});

export const readSafariCookies = Effect.fn("SafariCookies.readSafariCookies")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFile(cookiePath).pipe(
    Effect.mapError((cause) => {
      // TCC denies the read even though the file exists — a permission the user
      // grants in System Settings rather than a missing browser. macOS never
      // prompts for Full Disk Access, so there is no dialog to wait on; the
      // read just fails, and it fails with EPERM, which Effect surfaces as an
      // `Unknown` system error rather than `PermissionDenied` (that is EACCES).
      return new SafariCookieReadError({
        reason: isPermissionDenied(cause) ? "needsFullDiskAccess" : "readFailed",
        cookieDatabasePath: cookiePath,
        cause,
      });
    }),
  );
  // The parser throws on a malformed jar; catch it here so callers see a typed
  // failure rather than a defect.
  return yield* Effect.try({
    try: () => parseBinaryCookies(Buffer.from(contents)),
    catch: (cause) =>
      isSafariCookieReadError(cause)
        ? new SafariCookieReadError({
            reason: cause.reason,
            cookieDatabasePath: cookiePath,
            cause,
          })
        : new SafariCookieReadError({
            reason: "readFailed",
            cookieDatabasePath: cookiePath,
            cause,
          }),
  });
});
