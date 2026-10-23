import type { ZipPreviewEntry } from "@t3tools/client-runtime/zip-preview";
import { describe, expect, it } from "vite-plus/test";

import { buildZipTree, flattenZipTree, isZipAttachment, zipFolderLabel } from "./zipTree";

const file = (path: string, sizeBytes = 1): ZipPreviewEntry => ({
  path,
  name: path.split("/").at(-1)!,
  isDirectory: false,
  sizeBytes,
  mimeType: null,
});
const folder = (path: string): ZipPreviewEntry => ({
  path,
  name: path.slice(0, -1).split("/").at(-1)!,
  isDirectory: true,
  sizeBytes: 0,
  mimeType: null,
});

const entries = [
  folder("src/"),
  folder("src/main/"),
  folder("src/main/java/"),
  folder("src/main/java/shop/"),
  folder("src/main/java/shop/checkout/"),
  file("src/main/java/shop/checkout/Cart.java"),
  folder("src/lib/"),
  file("src/lib/cart.ts"),
  file("README.md"),
  folder("logs/"),
  file("logs/server.log"),
];

const labels = (rows: ReturnType<typeof flattenZipTree>) =>
  rows.map(({ node, depth }) => `${"  ".repeat(depth)}${node.label}`);

describe("zip tree", () => {
  it("keeps the top folder chain for a single nested file", () => {
    const tree = buildZipTree([file("src/lib/cart.ts")]);
    expect(labels(flattenZipTree(tree, new Set(), ""))).toEqual(["src/lib", "  cart.ts"]);
  });

  it("keeps a single empty folder", () => {
    const tree = buildZipTree([folder("empty/")]);
    expect(labels(flattenZipTree(tree, new Set(), ""))).toEqual(["empty"]);
  });

  it("lists folders first, flattens single-folder chains, and counts files", () => {
    const tree = buildZipTree(entries);
    expect(labels(flattenZipTree(tree, new Set(), ""))).toEqual([
      "logs",
      "  server.log",
      "src",
      "  lib",
      "    cart.ts",
      "  main/java/shop/checkout",
      "    Cart.java",
      "README.md",
    ]);
    expect(tree.find((node) => node.label === "src")?.fileCount).toBe(2);
  });

  it("hides children of collapsed folders", () => {
    expect(labels(flattenZipTree(buildZipTree(entries), new Set(["src"]), ""))).toEqual([
      "logs",
      "  server.log",
      "src",
      "README.md",
    ]);
  });

  it("filters by path, opens collapsed ancestors, and returns nothing when no file matches", () => {
    const tree = buildZipTree(entries);
    expect(labels(flattenZipTree(tree, new Set(["src"]), "LIB/"))).toEqual([
      "src",
      "  lib",
      "    cart.ts",
    ]);
    expect(flattenZipTree(tree, new Set(), "invoice")).toEqual([]);
  });

  it("dims leading folders and keeps the last segment", () => {
    expect(zipFolderLabel("main/java/shop/checkout")).toEqual({
      prefix: "main/…/shop/",
      name: "checkout",
    });
    expect(zipFolderLabel("main/java")).toEqual({ prefix: "main/", name: "java" });
    expect(zipFolderLabel("src")).toEqual({ prefix: "", name: "src" });
  });

  it("detects ZIP attachments by type or extension", () => {
    expect(isZipAttachment({ name: "a.bin", mimeType: "application/zip" })).toBe(true);
    expect(isZipAttachment({ name: "A.ZIP", mimeType: "application/octet-stream" })).toBe(true);
    expect(isZipAttachment({ name: "a.tar", mimeType: "application/x-tar" })).toBe(false);
  });
});
