import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseT3ProjectFile, T3ProjectFileFromJson } from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});

describe("worktree paths", () => {
  it("normalizes trailing slashes and keeps nested folders", () => {
    expect(
      parseT3ProjectFile(`{
        "worktreeSharedPaths": [" .zig-cache/ ", "app/.next/cache"],
        "worktreeClonePaths": ["node_modules//"]
      }`),
    ).toEqual({
      worktreeSharedPaths: [".zig-cache", "app/.next/cache"],
      worktreeClonePaths: ["node_modules"],
    });
  });

  it.each([
    "/abs/cache",
    "../outside",
    "a/../../b",
    "./cache",
    ".",
    ".t3",
    ".git/objects",
    ".env",
    "app/.env.local",
    "C:/cache",
    "back\\slash",
    "",
  ])("rejects %j", (entry) => {
    expect(parseT3ProjectFile(JSON.stringify({ worktreeClonePaths: [entry] }))).toBeNull();
  });
});
