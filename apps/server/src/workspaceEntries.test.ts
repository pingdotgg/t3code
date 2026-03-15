import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, assert, describe, it, vi } from "vitest";

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

function runGit(cwd: string, args: string[], options?: { config?: string[] }): void {
  const gitArgs = [...(options?.config ?? []).flatMap((entry) => ["-c", entry]), ...args];
  const result = spawnSync("git", gitArgs, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${gitArgs.join(" ")} failed`);
  }
}

function initGitRepo(cwd: string): void {
  runGit(cwd, ["init"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
}

function commitAll(cwd: string, message: string): void {
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", message]);
}

describe("searchWorkspaceEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

    assert.include(paths, "src");
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
    assert.include(paths, "README.md");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".git")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("node_modules")));
    assert.isFalse(result.truncated);
  });

  it("filters and ranks entries by query", async () => {
    const cwd = makeTempDir("t3code-workspace-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.some((entry) => entry.path === "src/components"));
    assert.isTrue(result.entries.every((entry) => entry.path.toLowerCase().includes("compo")));
  });

  it("supports fuzzy subsequence queries for composer path search", async () => {
    const cwd = makeTempDir("t3code-workspace-fuzzy-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
    const paths = result.entries.map((entry) => entry.path);

    assert.isAbove(result.entries.length, 0);
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
  });

  it("tracks truncation without sorting every fuzzy match", async () => {
    const cwd = makeTempDir("t3code-workspace-fuzzy-limit-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

    assert.lengthOf(result.entries, 1);
    assert.isTrue(result.truncated);
  });

  it("excludes gitignored paths for git repositories", async () => {
    const cwd = makeTempDir("t3code-workspace-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
    writeFile(cwd, "src/keep.ts", "export {};");
    writeFile(cwd, "ignored.txt", "ignore me");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("convex/")));
  });

  it("excludes tracked paths that match ignore rules", async () => {
    const cwd = makeTempDir("t3code-workspace-tracked-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");
    runGit(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
    writeFile(cwd, ".gitignore", ".convex/\n");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("excludes .convex in non-git workspaces", async () => {
    const cwd = makeTempDir("t3code-workspace-non-git-convex-");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("includes files inside initialized git submodules", async () => {
    const submoduleOrigin = makeTempDir("t3code-workspace-submodule-origin-");
    initGitRepo(submoduleOrigin);
    writeFile(submoduleOrigin, "src/submodule-file.ts", "export {};");
    writeFile(submoduleOrigin, "README.md", "# submodule\n");
    commitAll(submoduleOrigin, "Initial submodule");

    const cwd = makeTempDir("t3code-workspace-submodule-root-");
    initGitRepo(cwd);
    writeFile(cwd, "src/root.ts", "export {};");
    runGit(cwd, ["add", "src/root.ts"]);
    runGit(cwd, ["commit", "-m", "Initial root"]);
    runGit(cwd, ["submodule", "add", "-q", submoduleOrigin, "vendor/submodule"], {
      config: ["protocol.file.allow=always"],
    });
    writeFile(cwd, "vendor/submodule/untracked.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);
    const submoduleRootEntry = result.entries.find((entry) => entry.path === "vendor/submodule");

    assert.include(paths, "vendor");
    assert.include(paths, "vendor/submodule");
    assert.include(paths, "vendor/submodule/README.md");
    assert.include(paths, "vendor/submodule/src");
    assert.include(paths, "vendor/submodule/src/submodule-file.ts");
    assert.include(paths, "vendor/submodule/untracked.ts");
    assert.deepInclude(submoduleRootEntry, {
      path: "vendor/submodule",
      kind: "directory",
      parentPath: "vendor",
    });
    assert.isFalse(
      result.entries.some((entry) => entry.path === "vendor/submodule" && entry.kind === "file"),
    );
  });

  it("includes files inside nested initialized git submodules", async () => {
    const nestedOrigin = makeTempDir("t3code-workspace-nested-submodule-origin-");
    initGitRepo(nestedOrigin);
    writeFile(nestedOrigin, "src/nested-file.ts", "export {};");
    commitAll(nestedOrigin, "Initial nested submodule");

    const submoduleOrigin = makeTempDir("t3code-workspace-parent-submodule-origin-");
    initGitRepo(submoduleOrigin);
    writeFile(submoduleOrigin, "src/submodule-file.ts", "export {};");
    commitAll(submoduleOrigin, "Initial parent submodule");
    runGit(submoduleOrigin, ["submodule", "add", "-q", nestedOrigin, "deps/nested-submodule"], {
      config: ["protocol.file.allow=always"],
    });
    runGit(submoduleOrigin, ["commit", "-am", "Add nested submodule"]);

    const cwd = makeTempDir("t3code-workspace-nested-submodule-root-");
    initGitRepo(cwd);
    writeFile(cwd, "src/root.ts", "export {};");
    runGit(cwd, ["add", "src/root.ts"]);
    runGit(cwd, ["commit", "-m", "Initial root"]);
    runGit(cwd, ["submodule", "add", "-q", submoduleOrigin, "vendor/submodule"], {
      config: ["protocol.file.allow=always"],
    });
    runGit(cwd, ["commit", "-am", "Add submodule"]);
    runGit(cwd, ["submodule", "update", "--init", "--recursive"], {
      config: ["protocol.file.allow=always"],
    });

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 200 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "vendor/submodule");
    assert.include(paths, "vendor/submodule/deps");
    assert.include(paths, "vendor/submodule/deps/nested-submodule");
    assert.include(paths, "vendor/submodule/deps/nested-submodule/src");
    assert.include(paths, "vendor/submodule/deps/nested-submodule/src/nested-file.ts");
    assert.isFalse(
      result.entries.some(
        (entry) => entry.path === "vendor/submodule/deps/nested-submodule" && entry.kind === "file",
      ),
    );
  });

  it("applies submodule-local ignore rules when listing submodule files", async () => {
    const submoduleOrigin = makeTempDir("t3code-workspace-submodule-ignore-origin-");
    initGitRepo(submoduleOrigin);
    writeFile(submoduleOrigin, ".gitignore", "ignored.ts\n");
    writeFile(submoduleOrigin, "src/submodule-file.ts", "export {};");
    commitAll(submoduleOrigin, "Initial submodule");

    const cwd = makeTempDir("t3code-workspace-submodule-ignore-root-");
    initGitRepo(cwd);
    writeFile(cwd, "src/root.ts", "export {};");
    runGit(cwd, ["add", "src/root.ts"]);
    runGit(cwd, ["commit", "-m", "Initial root"]);
    runGit(cwd, ["submodule", "add", "-q", submoduleOrigin, "vendor/submodule"], {
      config: ["protocol.file.allow=always"],
    });
    writeFile(cwd, "vendor/submodule/ignored.ts", "export {};");
    writeFile(cwd, "vendor/submodule/keep.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 200 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "vendor/submodule/keep.ts");
    assert.notInclude(paths, "vendor/submodule/ignored.ts");
  });

  it("deduplicates concurrent index builds for the same cwd", async () => {
    const cwd = makeTempDir("t3code-workspace-concurrent-build-");
    writeFile(cwd, "src/components/Composer.tsx");

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await Promise.all([
      searchWorkspaceEntries({ cwd, query: "", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "comp", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "src", limit: 100 }),
    ]);

    assert.equal(rootReadCount, 1);
  });

  it("limits concurrent directory reads while walking the filesystem", async () => {
    const cwd = makeTempDir("t3code-workspace-read-concurrency-");
    for (let index = 0; index < 80; index += 1) {
      writeFile(cwd, `group-${index}/entry-${index}.ts`, "export {};");
    }

    let activeReads = 0;
    let peakReads = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(cwd)) {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 4));
        try {
          return await originalReaddir(...args);
        } finally {
          activeReads -= 1;
        }
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await searchWorkspaceEntries({ cwd, query: "", limit: 200 });

    assert.isAtMost(peakReads, 32);
  });
});
