import { describe, expect, it } from "vite-plus/test";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  isMissingProjectConfig,
  parseRepositoryPaths,
  updateRepositoryConfig,
} from "./ProjectRepositorySettings.logic";

describe("repository settings", () => {
  it("patches only edited fields, preserving comments, scripts, and unfamiliar config", () => {
    const original = `{
  // Team startup commands
  "scripts": [{ "name": "dev", "command": "npm run dev" }],
  "custom": { "keep": true },
  "repositories": { "paths": ["projects/*"], "includeSubmodules": false, "future": 1 },
}`;
    const updated = updateRepositoryConfig(original, { includeSubmodules: true });
    expect(updated).toContain("// Team startup commands");
    expect(updated).toContain('"scripts": [{ "name": "dev", "command": "npm run dev" }]');
    expect(updated).toContain('"custom": { "keep": true }');
    expect(updated).toContain('"paths": ["projects/*"]');
    expect(updated).toContain('"future": 1');
    expect(updated).toContain('"includeSubmodules": true');
  });
  it("creates repository settings in an empty config and permits clearing paths", () => {
    const created = updateRepositoryConfig("{}\n", {
      paths: ["projects/*"],
      includeSubmodules: true,
    });
    expect(JSON.parse(created).repositories).toEqual({
      paths: ["projects/*"],
      includeSubmodules: true,
    });
    expect(JSON.parse(updateRepositoryConfig(created, { paths: [] })).repositories).toEqual({
      paths: [],
      includeSubmodules: true,
    });
  });
  it("refuses to overwrite malformed or invalid configuration", () => {
    for (const original of ['{"scripts":', '{"scripts":false}', "[]"]) {
      expect(() => updateRepositoryConfig(original, { paths: [] })).toThrow("invalid t3.json");
    }
  });
  it("normalizes paths and rejects recursive or escaping discovery", () => {
    expect(parseRepositoryPaths(" projects/*\n\napps/backend\nprojects/* ")).toEqual([
      "projects/*",
      "apps/backend",
    ]);
    for (const path of [
      "../other",
      "/tmp/repo",
      "projects/**",
      "projects/*/nested",
      "C:/repos",
      "projects/../other",
      ".",
      "./",
      "*",
    ]) {
      expect(() => parseRepositoryPaths(path)).toThrow("Invalid repository path");
    }
  });
  it("distinguishes a missing file from a missing workspace or inaccessible file after wire decoding", () => {
    const decode = Schema.decodeUnknownSync(ProjectReadFileError);
    const error = (operation: string, code: string) =>
      decode({
        _tag: "ProjectReadFileError",
        message: "File read failed",
        failure: "operation_failed",
        operation,
        code,
      });
    expect(isMissingProjectConfig(error("realpath-target", "ENOENT"))).toBe(true);
    expect(isMissingProjectConfig(error("realpath-workspace-root", "ENOENT"))).toBe(false);
    expect(isMissingProjectConfig(error("open", "EACCES"))).toBe(false);
    expect(isMissingProjectConfig({ message: "ENOENT" })).toBe(false);
  });
});
