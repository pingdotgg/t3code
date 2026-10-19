import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { cookieScope, type ImportedCookie } from "./CookieDatabase.ts";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** `u32 0x00000100`, `u32le cookieCount`, then one `u32le` offset per cookie. */
const COOKIE_PAGE_HEADER_SIZE = 12;
const COOKIE_RECORD_HEADER_SIZE = 56;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export const SafariCookieReadFailure = Schema.Literals(["needsFullDiskAccess", "readFailed"]);
export type SafariCookieReadFailure = typeof SafariCookieReadFailure.Type;

export class SafariCookieReadError extends Schema.TaggedError<SafariCookieReadError>()(
  "SafariCookieReadError",
  {
    reason: SafariCookieReadFailure,
    cookieDatabasePath: Schema.optional(Schema.String),
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

function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

export function parseBinaryCookies(buffer: Buffer): ReadonlyArray<ImportedCookie> {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }

  const pageCount = buffer.readUInt32BE(4);
  // `Buffer.subarray` clamps silently, so accepting a short page or an overlong
  // record would return a cookie set that is quietly missing entries or
  // carrying fields read out of the next record — a partial import the user has
  // no way to notice.
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
  // length-prefixed property list.
  const trailer = buffer.length - pageStart;
  const validTrailer =
    trailer === 0 ||
    trailer === 8 ||
    (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) {
    throw new SafariCookieReadError({ reason: "readFailed" });
  }

  return cookies;
}

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
 * `stat` succeeds on the jar inside Safari's container even without Full Disk
 * Access — that is what lets the listing find it — so presence alone cannot
 * tell granted from denied.
 * */
export const safariAccessDenied = Effect.fnUntraced(function* (cookiePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(cookiePath, { flag: "r" }).pipe(
    Effect.as(false),
    Effect.catch((cause) => Effect.succeed(isPermissionDenied(cause))),
    Effect.scoped,
  );
});

export const safariAccessGranted = Effect.fnUntraced(function* (cookiePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.open(cookiePath, { flag: "r" }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
    Effect.scoped,
  );
});

export const readSafariCookies = Effect.fn("SafariCookies.readSafariCookies")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFile(cookiePath).pipe(
    Effect.mapError((cause) => {
      return new SafariCookieReadError({
        reason: isPermissionDenied(cause) ? "needsFullDiskAccess" : "readFailed",
        cookieDatabasePath: cookiePath,
        cause,
      });
    }),
  );
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
