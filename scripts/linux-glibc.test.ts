// @effect-diagnostics nodeBuiltinImport:off - Exercises the packaging filesystem and readelf.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import afterPack from "./linux-after-pack.ts";
import { parseGlibcNeeds, scanGlibcNeeds } from "./linux-glibc.ts";

it.each([
  ["GLIBC_2.9", "2.9"],
  ["GLIBC_2.34", "2.34"],
  ["GLIBC_2.2.5", "2.2.5"],
  ["GLIBC_ABI_DT_RELR", "2.36"],
])("reads required %s without counting newer definitions", (name, expected) => {
  expect(
    parseGlibcNeeds(`
Version definition section '.gnu.version_d' contains 1 entry:
  0x0010: Rev: 1 Flags: none Index: 2 Cnt: 1 Name: GLIBC_2.99
Version needs section '.gnu.version_r' contains 1 entry:
  000000: Version: 1 File: libc.so.6 Cnt: 3
  0x0010: Name: GLIBC_2.2 Flags: none Version: 3
  0x0020: Name: ${name} Flags: none Version: 4
  0x0030: Name: GLIBCXX_3.4.30 Flags: none Version: 5
`),
  ).toBe(expected);
});

it("compares required versions numerically", () => {
  expect(
    parseGlibcNeeds(`Version needs section '.gnu.version_r' contains 1 entry:
  0x0010: Name: GLIBC_2.9 Flags: none Version: 3
  0x0020: Name: GLIBC_2.10 Flags: none Version: 4
`),
  ).toBe("2.10");
});

it("ignores definitions, symbol tables, and unversioned/static binaries", () => {
  expect(parseGlibcNeeds("No version information found in this file.")).toBeUndefined();
  expect(
    parseGlibcNeeds(`
Version symbols section '.gnu.version' contains 1 entry:
  000: 2 (GLIBC_2.99)
Version definition section '.gnu.version_d' contains 1 entry:
  0x0010: Rev: 1 Flags: none Index: 2 Cnt: 1 Name: GLIBC_2.99
`),
  ).toBeUndefined();
});

it.each(["GLIBC_PRIVATE", "GLIBC_ABI_UNKNOWN"])("rejects unhandled requirement %s", (name) => {
  expect(() =>
    parseGlibcNeeds(`Version needs section '.gnu.version_r' contains 1 entry:
  0x0010: Name: ${name} Flags: none Version: 3
`),
  ).toThrow(name);
});

// Minimal ELF64 with a linked string table and a version NEEDS section, for both release CPUs.
function elfFixture(machine: number, version: string): Buffer {
  const strings = Buffer.from(`\0libc.so.6\0GLIBC_${version}\0`);
  const names = Buffer.from("\0.shstrtab\0.dynstr\0.gnu.version_r\0");
  const stringsOffset = 64;
  const namesOffset = stringsOffset + strings.length;
  const needsOffset = namesOffset + names.length;
  const sectionsOffset = needsOffset + 32;
  const elf = Buffer.alloc(sectionsOffset + 4 * 64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elf);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(machine, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(sectionsOffset), 40);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(64, 58);
  elf.writeUInt16LE(4, 60);
  elf.writeUInt16LE(1, 62);
  strings.copy(elf, stringsOffset);
  names.copy(elf, namesOffset);
  elf.writeUInt16LE(1, needsOffset);
  elf.writeUInt16LE(1, needsOffset + 2);
  elf.writeUInt32LE(1, needsOffset + 4);
  elf.writeUInt32LE(16, needsOffset + 8);
  elf.writeUInt16LE(2, needsOffset + 16 + 6);
  elf.writeUInt32LE(11, needsOffset + 16 + 8);
  for (const [index, name, type, offset, size, link] of [
    [1, 1, 3, namesOffset, names.length, 0],
    [2, 11, 3, stringsOffset, strings.length, 0],
    [3, 19, 0x6ffffffe, needsOffset, 32, 2],
  ] as const) {
    const section = sectionsOffset + index * 64;
    elf.writeUInt32LE(name, section);
    elf.writeUInt32LE(type, section + 4);
    elf.writeBigUInt64LE(BigInt(offset), section + 24);
    elf.writeBigUInt64LE(BigInt(size), section + 32);
    elf.writeUInt32LE(link, section + 40);
    elf.writeBigUInt64LE(1n, section + 48);
  }
  elf.writeUInt32LE(1, sectionsOffset + 3 * 64 + 44);
  return elf;
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("packaged ELF scan", () => {
  it.each([62, 183])(
    "checks executable, addon and extensionless ELF requirements for machine %s",
    async (machine) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-glibc-"));
      try {
        const app = NodePath.join(root, "app");
        const native = NodePath.join(app, "resources/app.asar.unpacked/node_modules/addon");
        await NodeFSP.mkdir(native, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(app, "t3code"), elfFixture(machine, "2.25"));
        await NodeFSP.writeFile(NodePath.join(native, "pty.node"), elfFixture(machine, "2.34"));
        await NodeFSP.writeFile(NodePath.join(app, "not-elf"), "GLIBC_2.99");
        await NodeFSP.writeFile(NodePath.join(root, "outside"), elfFixture(machine, "2.99"));
        await NodeFSP.symlink("../outside", NodePath.join(app, "symlink"));
        expect(await scanGlibcNeeds(app)).toEqual({ minimum: "2.34", elfCount: 2 });
        const deb = { name: "deb", options: { depends: ["libnss3"] } };
        await afterPack({ appOutDir: app, electronPlatformName: "linux", targets: [deb] });
        expect(deb.options.depends).toEqual(["libnss3", "libc6 (>= 2.34)"]);
        await NodeFSP.writeFile(NodePath.join(native, "helper"), elfFixture(machine, "2.40"));
        await expect(
          afterPack({ appOutDir: app, electronPlatformName: "linux", targets: [deb] }),
        ).rejects.toThrow(/helper.*GLIBC_2\.40.*2\.39/s);
        await NodeFSP.writeFile(NodePath.join(native, "helper"), Buffer.from("\x7fELFbroken"));
        await expect(scanGlibcNeeds(app)).rejects.toThrow(/helper/);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
