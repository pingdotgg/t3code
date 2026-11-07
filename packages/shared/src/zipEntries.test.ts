import { describe, expect, it } from "vite-plus/test";

import { buildZip } from "./testing/zipFixture.ts";
import { readZipEntry, zipEntries } from "./zipEntries.ts";

describe("zipEntries", () => {
  it("reads stored and deflated entries", async () => {
    const text = "hello ".repeat(100);
    const bytes = await buildZip({ "a.txt": { text, deflate: true }, "dir/b.txt": { text: "b" } });
    const entries = zipEntries(bytes)!;
    expect([...entries.keys()]).toEqual(["a.txt", "dir/b.txt"]);
    const decode = async (name: string, max = 1024) =>
      new TextDecoder().decode((await readZipEntry(bytes, entries.get(name)!, max))!);
    expect(await decode("a.txt")).toBe(text);
    expect(await decode("dir/b.txt")).toBe("b");
  });

  it("stops inflating past the limit, even when the declared size lies", async () => {
    const bytes = await buildZip({ "big.txt": { text: "x".repeat(10_000), deflate: true } });
    const entry = zipEntries(bytes)!.get("big.txt")!;
    expect(await readZipEntry(bytes, entry, 1000)).toBeNull();
    expect(await readZipEntry(bytes, { ...entry, size: 10 }, 1000)).toBeNull();
  });

  it("rejects data that is not a ZIP archive", () => {
    expect(zipEntries(new TextEncoder().encode("solid part"))).toBeNull();
  });
});
