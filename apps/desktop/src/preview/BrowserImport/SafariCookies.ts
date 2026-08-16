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
import * as Schema from "effect/Schema";

import type { ImportedCookie } from "./CookieDatabase.ts";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export const SafariCookieReadFailure = Schema.Literals(["needsFullDiskAccess", "readFailed"]);
export type SafariCookieReadFailure = typeof SafariCookieReadFailure.Type;

export class SafariCookieReadError extends Schema.TaggedErrorClass<SafariCookieReadError>()(
  "SafariCookieReadError",
  {
    reason: SafariCookieReadFailure,
    /** Kept for the log; never surfaced to the user. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read Safari cookies: ${this.reason}.`;
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
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;
    if (page.length < 12) continue;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart + 48 > page.length) continue;
      const cookie = page.subarray(cookieStart);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      const domain = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const path = readCString(cookie, pathOffset);
      const value = readCString(cookie, valueOffset);
      if (domain === "" || name === "") continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      const host = domain.startsWith(".") ? domain.slice(1) : domain;
      const expirationDate =
        expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined;

      cookies.push({
        url: `${secure ? "https" : "http"}://${host}${path || "/"}`,
        name,
        value,
        domain,
        path: path || "/",
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expirationDate,
        // The format predates SameSite and carries no equivalent field. Lax is
        // the modern browser default; claiming "none" would widen every
        // imported cookie's scope.
        sameSite: "lax",
      });
    }
  }

  return cookies;
}

export const readSafariCookies = Effect.fn("SafariCookies.readSafariCookies")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFile(cookiePath).pipe(
    Effect.mapError((cause) => {
      // TCC denies the read even though the file exists, which is a permission
      // the user can grant rather than a missing browser.
      const denied = cause.reason._tag === "PermissionDenied";
      return new SafariCookieReadError({
        reason: denied ? "needsFullDiskAccess" : "readFailed",
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
        ? cause
        : new SafariCookieReadError({ reason: "readFailed", cause }),
  });
});
