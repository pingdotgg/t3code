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

  it("decodes slash commands and rejects names that cannot be typed", () => {
    const decoded = decodeJson(`{
      "commands": [
        { "name": "graph", "description": "Graph", "run": ["~/bin/graph", "--html"], "output": "html" },
      ],
    }`);
    expect(decoded.commands?.[0]).toMatchObject({ name: "graph", output: "html" });
    expect(() =>
      decodeJson(
        `{ "commands": [{ "name": "two words", "description": "x", "run": ["a"], "output": "markdown" }] }`,
      ),
    ).toThrow();
    expect(() =>
      decodeJson(
        `{ "commands": [{ "name": "ok", "description": "x", "run": [], "output": "markdown" }] }`,
      ),
    ).toThrow();
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
