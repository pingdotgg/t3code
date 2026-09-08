import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWorkerModules } from "../preview-server.ts";

describe("readWorkerModules", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await NodeFs.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "distilled-modules-"),
    );
    await NodeFs.mkdir(NodePath.join(directory, "assets"), { recursive: true });
    await NodeFs.mkdir(NodePath.join(directory, "ssr"), { recursive: true });
    await NodeFs.writeFile(
      NodePath.join(directory, "entry.js"),
      "export default {};",
    );
    await NodeFs.writeFile(NodePath.join(directory, "entry.js.map"), "{}");
    await NodeFs.writeFile(
      NodePath.join(directory, "assets", "chunk.js"),
      "export const a = 1;",
    );
    await NodeFs.writeFile(
      NodePath.join(directory, "ssr", "index.js"),
      "export const s = 1;",
    );
    await NodeFs.writeFile(NodePath.join(directory, "manifest.json"), "{}");
    await NodeFs.writeFile(NodePath.join(directory, "notes.txt"), "text");
    await NodeFs.writeFile(
      NodePath.join(directory, "blob.bin"),
      new Uint8Array([1, 2, 3]),
    );
    await NodeFs.writeFile(
      NodePath.join(directory, "lib.wasm"),
      new Uint8Array([0, 97, 115, 109]),
    );
  });

  afterAll(async () => {
    await NodeFs.rm(directory, { recursive: true, force: true });
  });

  it("reads the output directory recursively, entry first, skipping source maps", async () => {
    const modules = await readWorkerModules({
      directory,
      entryModule: "entry.js",
    });
    expect(modules[0]).toMatchObject({ name: "entry.js", type: "ESModule" });
    const byName = new Map(modules.map((module) => [module.name, module]));
    expect(byName.has("entry.js.map")).toBe(false);
    expect(byName.get("assets/chunk.js")).toMatchObject({ type: "ESModule" });
    expect(byName.get("ssr/index.js")).toMatchObject({ type: "ESModule" });
    expect(byName.get("manifest.json")).toMatchObject({ type: "Json" });
    expect(byName.get("notes.txt")).toMatchObject({ type: "Text" });
    expect(byName.get("blob.bin")).toMatchObject({ type: "Data" });
    expect(byName.get("lib.wasm")).toMatchObject({ type: "Wasm" });
    expect(byName.get("lib.wasm")?.content).toBeInstanceOf(Uint8Array);
  });

  it("fails when the entry module is not in the output", async () => {
    await expect(
      readWorkerModules({ directory, entryModule: "nope.js" }),
    ).rejects.toThrow(/nope\.js/);
  });
});
