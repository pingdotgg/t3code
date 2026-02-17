import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { searchWorkspaceEntries } from "./workspaceEntries";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

describe("searchWorkspaceEntries", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns files and directories relative to cwd", async () => {
    const cwd = makeTempDir("t3code-workspace-entries-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "README.md");
    writeFile(cwd, ".git/HEAD");
    writeFile(cwd, "node_modules/pkg/index.js");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain("src");
    expect(paths).toContain("src/components");
    expect(paths).toContain("src/components/Composer.tsx");
    expect(paths).toContain("README.md");
    expect(paths.some((entryPath) => entryPath.startsWith(".git"))).toBe(false);
    expect(paths.some((entryPath) => entryPath.startsWith("node_modules"))).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("filters and ranks entries by query", async () => {
    const cwd = makeTempDir("t3code-workspace-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.path === "src/components")).toBe(true);
    expect(result.entries.every((entry) => entry.path.toLowerCase().includes("compo"))).toBe(true);
  });
});
