// @effect-diagnostics nodeBuiltinImport:off - fixtures are built in memory with Node's zlib to mirror upstream release archives.
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  TailcatArchiveError,
  extractArchiveEntries,
  tailcatArchiveFormat,
} from "./tailcat-archive.ts";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- tar fixture ------------------------------------------------------------

function tarHeader(name: string, size: number, typeflag: string, prefix = ""): Uint8Array {
  const header = new Uint8Array(512);
  header.set(bytes(name), 0);
  header.set(bytes("0000755\0"), 100);
  header.set(bytes("0000000\0"), 108);
  header.set(bytes("0000000\0"), 116);
  header.set(bytes(`${size.toString(8).padStart(11, "0")}\0`), 124);
  header.set(bytes("00000000000\0"), 136);
  header.set(bytes("        "), 148);
  header[156] = typeflag.charCodeAt(0);
  header.set(bytes("ustar\0"), 257);
  header.set(bytes("00"), 263);
  header.set(bytes(prefix), 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(bytes(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

function tarMember(name: string, data: Uint8Array, typeflag = "0", prefix = ""): Uint8Array {
  const padding = new Uint8Array((512 - (data.length % 512)) % 512);
  return concat([tarHeader(name, data.length, typeflag, prefix), data, padding]);
}

function paxHeader(records: Readonly<Record<string, string>>): Uint8Array {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    const payload = ` ${key}=${value}\n`;
    let length = payload.length + 1;
    while (`${length}${payload}`.length !== length) length++;
    body += `${length}${payload}`;
  }
  return tarMember("PaxHeader/entry", bytes(body), "x");
}

function tarGz(members: ReadonlyArray<Uint8Array>): Uint8Array {
  return NodeZlib.gzipSync(concat([...members, new Uint8Array(1024)]));
}

// --- zip fixture ------------------------------------------------------------

interface ZipFixtureEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly deflate: boolean;
  readonly corruptCrc?: boolean;
}

function zipArchive(entries: ReadonlyArray<ZipFixtureEntry>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = bytes(entry.name);
    const compressed = entry.deflate ? NodeZlib.deflateRawSync(entry.data) : entry.data;
    const crc = NodeZlib.crc32(entry.data) ^ (entry.corruptCrc ? 0xffffffff : 0);
    const method = entry.deflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    localParts.push(local, compressed);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return concat([...localParts, ...centralParts, end]);
}

// --- tests ------------------------------------------------------------------

const binary = new Uint8Array(3000).map((_, index) => (index * 31) % 256);
const license = bytes("BSD 3-Clause License\n");

describe("tailcat-archive", () => {
  it("recognizes upstream archive formats", () => {
    assert.equal(tailcatArchiveFormat("tailcat_0.5.0_linux_amd64.tar.gz"), "tar.gz");
    assert.equal(tailcatArchiveFormat("tailcat_0.5.0_windows_amd64.zip"), "zip");
    assert.isUndefined(tailcatArchiveFormat("tailcat_0.5.0_linux_amd64.deb"));
  });

  it.effect("extracts wanted members from a tar.gz, following ustar prefixes and pax paths", () =>
    Effect.gen(function* () {
      const archive = tarGz([
        tarMember("tailcat-0.5.0/", new Uint8Array(0), "5"),
        tarMember("README.md", bytes("# tailcat\n")),
        tarMember("LICENSE", license, "0", "tailcat-0.5.0"),
        paxHeader({ path: "tailcat-0.5.0/bin/tailcat", mtime: "1700000000" }),
        tarMember("PaxHeader/placeholder", binary),
      ]);

      const entries = yield* extractArchiveEntries({
        archive: "fixture.tar.gz",
        bytes: archive,
        format: "tar.gz",
        wanted: ["tailcat", "LICENSE"],
      });

      assert.deepStrictEqual([...entries.keys()].sort(), ["LICENSE", "tailcat"]);
      assert.deepStrictEqual(entries.get("tailcat"), binary);
      assert.deepStrictEqual(entries.get("LICENSE"), license);
    }),
  );

  it.effect("extracts stored and deflated zip members and checks their CRCs", () =>
    Effect.gen(function* () {
      const archive = zipArchive([
        { name: "LICENSE", data: license, deflate: false },
        { name: "README.md", data: bytes("# tailcat\n"), deflate: true },
        { name: "tailcat.exe", data: binary, deflate: true },
      ]);

      const entries = yield* extractArchiveEntries({
        archive: "fixture.zip",
        bytes: archive,
        format: "zip",
        wanted: ["tailcat.exe", "LICENSE"],
      });
      assert.deepStrictEqual(entries.get("tailcat.exe"), binary);
      assert.deepStrictEqual(entries.get("LICENSE"), license);
      assert.isFalse(entries.has("README.md"));

      const corrupt = yield* extractArchiveEntries({
        archive: "corrupt.zip",
        bytes: zipArchive([{ name: "tailcat.exe", data: binary, deflate: true, corruptCrc: true }]),
        format: "zip",
        wanted: ["tailcat.exe"],
      }).pipe(Effect.flip);
      assert.instanceOf(corrupt, TailcatArchiveError);
      assert.equal(corrupt.reason, "checksum-mismatch");
      assert.equal(corrupt.detail, "tailcat.exe");
    }),
  );

  it.effect("rejects archives it cannot trust", () =>
    Effect.gen(function* () {
      const truncated = yield* extractArchiveEntries({
        archive: "truncated.tar.gz",
        bytes: tarGz([tarMember("tailcat", binary)]).subarray(0, 40),
        format: "tar.gz",
        wanted: ["tailcat"],
      }).pipe(Effect.flip);
      assert.instanceOf(truncated, TailcatArchiveError);
      assert.equal(truncated.reason, "corrupt");

      const notZip = yield* extractArchiveEntries({
        archive: "not.zip",
        bytes: bytes("definitely not a zip archive, but long enough to scan"),
        format: "zip",
        wanted: ["tailcat.exe"],
      }).pipe(Effect.flip);
      assert.instanceOf(notZip, TailcatArchiveError);
      assert.equal(notZip.reason, "corrupt");

      const ambiguous = yield* extractArchiveEntries({
        archive: "ambiguous.tar.gz",
        bytes: tarGz([tarMember("a/tailcat", binary), tarMember("b/tailcat", license)]),
        format: "tar.gz",
        wanted: ["tailcat"],
      }).pipe(Effect.flip);
      assert.instanceOf(ambiguous, TailcatArchiveError);
      assert.equal(ambiguous.reason, "entry-ambiguous");
      assert.equal(ambiguous.detail, "tailcat");
    }),
  );
});
