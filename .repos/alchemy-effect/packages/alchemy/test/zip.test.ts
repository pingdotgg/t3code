import { sha256 } from "@/Util/sha256";
import { zipCode, zipFiles } from "@/Util/zip";
import { strFromU8, unzipSync } from "fflate";
import * as Effect from "effect/Effect";
import { expect, test } from "alchemy-test";

test("zipCode is deterministic for identical inputs", async () => {
  const hash = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "index.mjs.map",
          content: JSON.stringify({
            version: 3,
            sources: ["index.ts"],
          }),
        },
      ]).pipe(Effect.flatMap(sha256)),
    );

  const first = await hash();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await hash()).toBe(first);
});

// Nested paths must remain deterministic across builds.
test("zipCode is deterministic for nested package paths", async () => {
  const build = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "node_modules/uuid/package.json",
          content: JSON.stringify({ name: "uuid" }),
        },
      ]),
    );

  const first = await build();
  const entries = unzipSync(first);
  expect(strFromU8(entries["node_modules/uuid/package.json"]!)).toBe(
    JSON.stringify({ name: "uuid" }),
  );

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await build();
  expect(await Effect.runPromise(sha256(second))).toBe(
    await Effect.runPromise(sha256(first)),
  );
});

test("zipFiles preserves binary data, Unicode, empty files, and input order independence", async () => {
  const files = [
    { path: "nested/你好.txt", content: "Hello 🌍" },
    { path: "binary", content: new Uint8Array([0, 255, 128, 1]) },
    { path: "empty", content: "" },
    { path: "large", content: "compress me".repeat(40000) },
  ];
  const first = await Effect.runPromise(zipFiles(files));
  const second = await Effect.runPromise(zipFiles([...files].reverse()));
  expect(Buffer.isBuffer(first)).toBe(true);
  expect(first.equals(second)).toBe(true);
  const entries = unzipSync(first);
  for (const file of files) {
    expect(entries[file.path]).toEqual(
      typeof file.content === "string"
        ? new TextEncoder().encode(file.content)
        : file.content,
    );
  }
  expect(Object.keys(unzipSync(await Effect.runPromise(zipFiles([]))))).toEqual(
    [],
  );
});

test("zipFiles records fixed timestamps and Unix file types and permissions", async () => {
  const archive = await Effect.runPromise(
    zipFiles([
      { path: "bin/tool", content: "#!/bin/sh", mode: 0o100755 },
      { path: "link", content: "bin/tool", mode: 0o120777 },
      { path: "plain", content: "text" },
    ]),
  );
  // Read the ZIP central directory independently of the compression library.
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  let offset = archive.readUInt32LE(end + 16);
  const modes: Record<string, number> = {};
  for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    expect(archive[offset + 5]).toBe(3);
    expect(archive.readUInt16LE(offset + 12)).toBe(0);
    expect(archive.readUInt16LE(offset + 14)).toBe(33);
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString(
      "utf8",
      offset + 46,
      offset + 46 + nameLength,
    );
    modes[name] = archive.readUInt32LE(offset + 38) >>> 16;
    offset +=
      46 +
      nameLength +
      archive.readUInt16LE(offset + 30) +
      archive.readUInt16LE(offset + 32);
  }
  expect(modes).toEqual({
    "bin/tool": 0o100755,
    link: 0o120777,
    plain: 0o100644,
  });
  expect(strFromU8(unzipSync(archive).link!)).toBe("bin/tool");
});
