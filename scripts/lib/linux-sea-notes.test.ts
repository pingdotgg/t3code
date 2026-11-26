import { describe, expect, it } from "@effect/vitest";
import { trimElfNotesForUek } from "./linux-sea-notes.ts";

const MiB = 1024 * 1024;
const pad = (size: number) => Math.ceil(size / 4) * 4;

function note(name: string, descSize: number) {
  const nameBytes = new TextEncoder().encode(`${name}\0`);
  const bytes = new Uint8Array(12 + pad(nameBytes.length) + pad(descSize));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, nameBytes.length, true);
  view.setUint32(4, descSize, true);
  bytes.set(nameBytes, 12);
  return bytes;
}

// One PT_NOTE covering the given notes, laid out like a postject-injected SEA.
function elf(notes: Array<Uint8Array>) {
  const notesOffset = 64 + 56;
  const size = notes.reduce((total, entry) => total + entry.length, 0);
  const bytes = new Uint8Array(notesOffset + size);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  view.setBigUint64(32, 64n, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint32(64, 4, true);
  view.setBigUint64(64 + 8, BigInt(notesOffset), true);
  view.setBigUint64(64 + 32, BigInt(size), true);
  view.setBigUint64(64 + 40, BigInt(size), true);
  view.setBigUint64(64 + 48, 4n, true);
  let offset = notesOffset;
  for (const entry of notes) {
    bytes.set(entry, offset);
    offset += entry.length;
  }
  return {
    bytes,
    size: BigInt(size),
    fileSize: () => view.getBigUint64(64 + 32, true),
    memSize: () => view.getBigUint64(64 + 40, true),
  };
}

describe("Linux SEA notes on Oracle UEK kernels", () => {
  it("stops p_filesz before the SEA blob and keeps p_memsz for Node's lookup", () => {
    const binary = elf([note("GNU", 20), note("GNU", 16), note("NODE_SEA_BLOB", 22 * MiB)]);
    expect(trimElfNotesForUek(binary.bytes)).toEqual([
      { index: 0, fileSize: binary.size, trimmedFileSize: 0x44n },
    ]);
    expect(binary.fileSize()).toBe(0x44n);
    expect(binary.memSize()).toBe(binary.size);
    expect(trimElfNotesForUek(binary.bytes)).toEqual([]);
  });

  it("leaves note segments of 4 MiB or less alone", () => {
    const binary = elf([note("GNU", 20), note("NODE_SEA_BLOB", 3 * MiB)]);
    const before = binary.bytes.slice();
    expect(trimElfNotesForUek(binary.bytes)).toEqual([]);
    expect(binary.bytes).toEqual(before);
  });

  it("rejects a note segment that starts with a note larger than 4 MiB", () => {
    const binary = elf([note("NODE_SEA_BLOB", 5 * MiB)]);
    expect(() => trimElfNotesForUek(binary.bytes)).toThrow(/larger than 4 MiB/);
  });

  it("rejects malformed headers", () => {
    expect(() => trimElfNotesForUek(new Uint8Array(64))).toThrow(/ELF64/);
    const binary = elf([note("GNU", 20), note("NODE_SEA_BLOB", 5 * MiB)]);
    expect(() => trimElfNotesForUek(binary.bytes.subarray(0, 4 * MiB))).toThrow(/past the end/);
  });
});
