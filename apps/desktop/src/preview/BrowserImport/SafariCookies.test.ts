// @effect-diagnostics nodeBuiltinImport:off - Hand-builds Safari's binary jar
// format byte by byte.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseBinaryCookies, readSafariCookies, SafariCookieReadError } from "./SafariCookies.ts";

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

interface FixtureCookie {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
  readonly flags: number;
  /** Seconds since 2001-01-01, as Safari stores them. */
  readonly expiry: number;
}

/** Encodes one cookie exactly as Safari lays it out. */
function encodeCookie(cookie: FixtureCookie): Buffer {
  const strings = [cookie.domain, cookie.name, cookie.path, cookie.value];
  const headerSize = 56;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const value of strings) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(value) + 1;
  }
  const size = cursor;

  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(size, 0);
  buffer.writeUInt32LE(0, 4);
  buffer.writeUInt32LE(cookie.flags, 8);
  buffer.writeUInt32LE(0, 12);
  buffer.writeUInt32LE(offsets[0]!, 16);
  buffer.writeUInt32LE(offsets[1]!, 20);
  buffer.writeUInt32LE(offsets[2]!, 24);
  buffer.writeUInt32LE(offsets[3]!, 28);
  buffer.writeUInt32LE(0, 32);
  buffer.writeUInt32LE(0, 36);
  buffer.writeDoubleLE(cookie.expiry, 40);
  buffer.writeDoubleLE(0, 48);
  strings.forEach((value, index) => {
    buffer.write(value, offsets[index]!, "utf8");
  });
  return buffer;
}

/** Builds a single-page `Cookies.binarycookies` file. */
function encodeBinaryCookies(cookies: ReadonlyArray<FixtureCookie>): Buffer {
  const encoded = cookies.map(encodeCookie);
  const headerSize = 12 + encoded.length * 4;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const cookie of encoded) {
    offsets.push(cursor);
    cursor += cookie.length;
  }

  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x0000_0100, 0);
  page.writeUInt32LE(encoded.length, 4);
  offsets.forEach((offset, index) => page.writeUInt32LE(offset, 8 + index * 4));
  encoded.forEach((cookie, index) => cookie.copy(page, offsets[index]!));

  const header = Buffer.alloc(8 + 4);
  header.write("cook", 0, "latin1");
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(page.length, 8);
  return Buffer.concat([header, page]);
}

describe("parseBinaryCookies", () => {
  it("reads Safari's format and rebases its 2001 epoch", () => {
    const file = encodeBinaryCookies([
      {
        domain: ".apple.com",
        name: "session",
        path: "/",
        value: "abc",
        // secure | httpOnly
        flags: 0x1 | 0x4,
        expiry: 800_000_000,
      },
      {
        domain: "example.test",
        name: "plain",
        path: "/app",
        value: "v",
        flags: 0,
        expiry: 0,
      },
    ]);

    expect(parseBinaryCookies(file)).toEqual([
      {
        url: "https://apple.com/",
        name: "session",
        value: "abc",
        domain: ".apple.com",
        path: "/",
        secure: true,
        httpOnly: true,
        // Safari counts from 2001-01-01, Electron from 1970.
        expirationDate: 800_000_000 + APPLE_EPOCH_OFFSET_SECONDS,
        // The format predates SameSite; Lax is the safe modern default.
        sameSite: "lax",
      },
      {
        url: "http://example.test/app",
        name: "plain",
        value: "v",
        domain: "example.test",
        path: "/app",
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: "lax",
      },
    ]);
  });

  it("reads cookies spread across multiple pages", () => {
    // Safari pages its cookie file, and a single-page reader would silently
    // return only the first slice.
    const first = encodeBinaryCookies([
      { domain: "a.test", name: "one", path: "/", value: "1", flags: 0, expiry: 1 },
    ]);
    const second = encodeBinaryCookies([
      { domain: "b.test", name: "two", path: "/", value: "2", flags: 0, expiry: 1 },
    ]);
    // Splice the two single-page files into one two-page file.
    const firstPage = first.subarray(12);
    const secondPage = second.subarray(12);
    const header = Buffer.alloc(16);
    header.write("cook", 0, "latin1");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(firstPage.length, 8);
    header.writeUInt32BE(secondPage.length, 12);

    const parsed = parseBinaryCookies(Buffer.concat([header, firstPage, secondPage]));

    expect(parsed.map((cookie) => cookie.name)).toEqual(["one", "two"]);
  });

  it("rejects a page that runs past the end of the file", () => {
    // `Buffer.subarray` clamps rather than throwing, so an overlong first page
    // swallows the second one's bytes and advances the cursor past the end.
    // Every cookie after the boundary then vanishes from a "successful" import.
    const first = encodeBinaryCookies([
      { domain: "a.test", name: "one", path: "/", value: "1", flags: 0, expiry: 1 },
    ]);
    const second = encodeBinaryCookies([
      { domain: "b.test", name: "two", path: "/", value: "2", flags: 0, expiry: 1 },
    ]);
    const firstPage = first.subarray(12);
    const secondPage = second.subarray(12);
    const header = Buffer.alloc(16);
    header.write("cook", 0, "latin1");
    header.writeUInt32BE(2, 4);
    // Declares more bytes for page one than the file holds in total.
    header.writeUInt32BE(firstPage.length + secondPage.length + 32, 8);
    header.writeUInt32BE(secondPage.length, 12);

    expect(() => parseBinaryCookies(Buffer.concat([header, firstPage, secondPage]))).toThrow(
      SafariCookieReadError,
    );
  });

  it("rejects a record whose declared size runs past its page", () => {
    const valid = encodeBinaryCookies([
      { domain: "a.test", name: "n", path: "/", value: "v", expiry: 1_000, flags: 0 },
    ]);
    // The record's own length is what bounds its string offsets; an inflated
    // one lets them read the following record's bytes as this cookie's value.
    const pageStart = 8 + 4;
    const recordStart = pageStart + valid.readUInt32LE(pageStart + 8);
    const corrupt = Buffer.from(valid);
    corrupt.writeUInt32LE(0xffff, recordStart);

    expect(() => parseBinaryCookies(corrupt)).toThrow(SafariCookieReadError);
  });

  it("rejects a file that is not binarycookies", () => {
    expect(() => parseBinaryCookies(Buffer.from("not a cookie jar"))).toThrow(
      SafariCookieReadError,
    );
  });
});

describe("readSafariCookies", () => {
  it.effect("reports a TCC denial as a permission the user can grant", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-safari-" });
      const jar = `${directory}/Cookies.binarycookies`;
      yield* fileSystem.writeFile(jar, new Uint8Array([0x63, 0x6f, 0x6f, 0x6b]));
      // What Full Disk Access actually looks like: the file is there, the read
      // is refused. Reporting that as a generic failure would send the user
      // looking for a missing browser instead of a checkbox.
      yield* fileSystem.chmod(jar, 0o000);

      const error = yield* readSafariCookies(jar).pipe(Effect.flip);

      assert.equal(error.reason, "needsFullDiskAccess");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports a missing jar as a plain read failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-safari-" });

      const error = yield* readSafariCookies(`${directory}/absent.binarycookies`).pipe(Effect.flip);

      assert.equal(error.reason, "readFailed");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
