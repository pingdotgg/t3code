// @effect-diagnostics nodeBuiltinImport:off - Hand-builds Safari's binary jar
// format byte by byte.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import {
  isPermissionDenied,
  parseBinaryCookies,
  readSafariCookies,
  safariAccessDenied,
  SafariCookieReadError,
} from "./SafariCookies.ts";

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

interface FixtureCookie {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
  readonly flags: number;
  readonly expiry: number;
}

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
        expirationDate: 800_000_000 + APPLE_EPOCH_OFFSET_SECONDS,
        sameSite: "lax",
      },
      {
        url: "http://example.test/app",
        name: "plain",
        value: "v",
        domain: undefined,
        path: "/app",
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: "lax",
      },
    ]);
  });

  it("keeps __Host- cookies host-only so Electron accepts them", () => {
    const file = encodeBinaryCookies([
      { domain: "example.test", name: "__Host-id", path: "/", value: "v", flags: 0x1, expiry: 0 },
    ]);

    expect(parseBinaryCookies(file)[0]).toMatchObject({
      url: "https://example.test/",
      name: "__Host-id",
      domain: undefined,
    });
  });

  it("reads cookies spread across multiple pages", () => {
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
    header.writeUInt32BE(firstPage.length, 8);
    header.writeUInt32BE(secondPage.length, 12);

    const parsed = parseBinaryCookies(Buffer.concat([header, firstPage, secondPage]));

    expect(parsed.map((cookie) => cookie.name)).toEqual(["one", "two"]);
  });

  it("rejects a page that runs past the end of the file", () => {
    // `Buffer.subarray` clamps rather than throwing, so an overlong first page
    // swallows the second one's bytes and advances the cursor past the end.
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
    header.writeUInt32BE(firstPage.length + secondPage.length + 32, 8);
    header.writeUInt32BE(secondPage.length, 12);

    expect(() => parseBinaryCookies(Buffer.concat([header, firstPage, secondPage]))).toThrow(
      SafariCookieReadError,
    );
  });

  it("rejects record offsets that point into the page header or an earlier record", () => {
    const valid = encodeBinaryCookies([
      { domain: "a.test", name: "n", path: "/", value: "v", expiry: 1_000, flags: 0 },
      { domain: "b.test", name: "m", path: "/", value: "w", expiry: 1_000, flags: 0 },
    ]);
    const pageStart = 8 + 4;
    const firstRecord = valid.readUInt32LE(pageStart + 8);

    const intoTable = Buffer.from(valid);
    intoTable.writeUInt32LE(4, pageStart + 12);
    expect(() => parseBinaryCookies(intoTable)).toThrow(SafariCookieReadError);

    const overlapping = Buffer.from(valid);
    overlapping.writeUInt32LE(firstRecord, pageStart + 12);
    expect(() => parseBinaryCookies(overlapping)).toThrow(SafariCookieReadError);

    expect(parseBinaryCookies(valid)).toHaveLength(2);
  });

  it("accepts the checksum and property-list trailer Safari writes", () => {
    const file = encodeBinaryCookies([
      { domain: "a.test", name: "c", path: "/", value: "v", flags: 0, expiry: 0 },
    ]);
    const checksum = Buffer.alloc(8);
    const plist = Buffer.from("bplist00 stub");
    const plistLength = Buffer.alloc(4);
    plistLength.writeUInt32BE(plist.length, 0);

    expect(parseBinaryCookies(Buffer.concat([file, checksum]))).toHaveLength(1);
    expect(parseBinaryCookies(Buffer.concat([file, checksum, plistLength, plist]))).toHaveLength(1);
  });
});

describe("readSafariCookies", () => {
  it.effect("reports a TCC denial as a permission the user can grant", () =>
    Effect.gen(function* () {
      // What Full Disk Access actually looks like: the file is there, the read
      // is refused with EPERM. Effect tags that `Unknown`, not
      // `PermissionDenied`, so the reader has to look at the errno.
      const denied = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: "/protected/Cookies.binarycookies",
        cause: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
      });

      const error = yield* readSafariCookies("/protected/Cookies.binarycookies").pipe(
        Effect.flip,
        Effect.provide(FileSystem.layerNoop({ readFile: () => Effect.fail(denied) })),
      );

      assert.equal(error.reason, "needsFullDiskAccess");
    }),
  );
});

describe("safariAccessDenied", () => {
  it.effect("does not read a readable jar, or any other failure, as denied", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-safari-" });
      const jar = `${directory}/Cookies.binarycookies`;
      yield* fileSystem.writeFile(jar, new Uint8Array([0x63, 0x6f, 0x6f, 0x6b]));
      assert.isFalse(yield* safariAccessDenied(jar));
      assert.isFalse(yield* safariAccessDenied(`${directory}/absent.binarycookies`));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("isPermissionDenied", () => {
  const platformError = (reasonTag: string, code: string): PlatformError.PlatformError =>
    ({ _tag: "PlatformError", reason: { _tag: reasonTag, cause: { code } } }) as never;

  it("does not send an ordinary EACCES failure to the Full Disk Access grant", () => {
    expect(isPermissionDenied(platformError("PermissionDenied", "EACCES"))).toBe(false);
  });
});
