import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  VIRTUAL_WORKSPACE_METADATA_FILE,
  cleanVirtualWorkspaceCache,
  ensureGithubVirtualWorkspaceClone,
  pruneVirtualWorkspaceCache,
  resolveGithubVirtualWorkspaceCheckoutPath,
} from "./virtualWorkspaceCache.ts";

describe("virtual workspace cache", () => {
  let t3Home: string;

  beforeEach(() => {
    t3Home = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-virtual-workspaces-"));
  });

  afterEach(() => {
    fs.rmSync(t3Home, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("clones GitHub virtual workspaces into a stable checkout and writes metadata", async () => {
    const key = "vscode-vfs:github:/microsoft/vscode";
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      const checkoutDir = args[3];
      if (!checkoutDir) {
        throw new Error("missing checkout dir");
      }
      fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
    });

    const checkoutDir = await ensureGithubVirtualWorkspaceClone({
      key,
      owner: "microsoft",
      repository: "vscode",
      cloneUrl: "https://github.com/microsoft/vscode.git",
      t3Home,
      dependencies: {
        mkdirSync: fs.mkdirSync,
        runCommand,
      },
      outputChannel: { appendLine: vi.fn() },
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    expect(checkoutDir).toBe(
      resolveGithubVirtualWorkspaceCheckoutPath({
        key,
        owner: "microsoft",
        repository: "vscode",
        t3Home,
      }),
    );
    expect(runCommand).toHaveBeenCalledWith("git", [
      "clone",
      "--filter=blob:none",
      "https://github.com/microsoft/vscode.git",
      checkoutDir,
    ]);
    expect(readMetadata(checkoutDir)).toEqual({
      version: 1,
      provider: "github",
      workspaceFolderKey: key,
      cloneUrl: "https://github.com/microsoft/vscode.git",
      createdAt: "2026-05-15T10:00:00.000Z",
      lastUsedAt: "2026-05-15T10:00:00.000Z",
      lastBackendStartedAt: "2026-05-15T10:00:00.000Z",
    });
  });

  it("refreshes existing checkouts before reuse and updates usage metadata without recloning", async () => {
    const key = "vscode-vfs:github:/microsoft/vscode";
    const checkoutDir = resolveGithubVirtualWorkspaceCheckoutPath({
      key,
      owner: "microsoft",
      repository: "vscode",
      t3Home,
    });
    fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
    writeMetadata(checkoutDir, {
      createdAt: "2026-05-01T10:00:00.000Z",
      lastUsedAt: "2026-05-01T10:00:00.000Z",
      lastBackendStartedAt: "2026-05-01T10:00:00.000Z",
      workspaceFolderKey: key,
    });
    const runCommand = vi.fn();

    await expect(
      ensureGithubVirtualWorkspaceClone({
        key,
        owner: "microsoft",
        repository: "vscode",
        cloneUrl: "https://github.com/microsoft/vscode.git",
        t3Home,
        dependencies: {
          mkdirSync: fs.mkdirSync,
          runCommand,
        },
        outputChannel: { appendLine: vi.fn() },
        now: new Date("2026-05-15T10:00:00.000Z"),
      }),
    ).resolves.toBe(checkoutDir);

    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(runCommand).toHaveBeenNthCalledWith(1, "git", [
      "-C",
      checkoutDir,
      "fetch",
      "--prune",
      "origin",
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, "git", [
      "-C",
      checkoutDir,
      "remote",
      "set-head",
      "origin",
      "--auto",
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(3, "git", [
      "-C",
      checkoutDir,
      "reset",
      "--hard",
      "origin/HEAD",
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(4, "git", ["-C", checkoutDir, "clean", "-ffdx"]);
    expect(readMetadata(checkoutDir)).toEqual(
      expect.objectContaining({
        createdAt: "2026-05-01T10:00:00.000Z",
        lastUsedAt: "2026-05-15T10:00:00.000Z",
        lastBackendStartedAt: "2026-05-15T10:00:00.000Z",
      }),
    );
  });

  it("prunes GitHub virtual workspace checkouts unused for 15 days while keeping active and recent entries", () => {
    const checkoutDirs = Array.from({ length: 13 }, (_, index) =>
      createCacheEntry({
        t3Home,
        name: `old-${String(index).padStart(2, "0")}`,
        lastUsedAt: new Date(Date.UTC(2026, 3, 1, index)).toISOString(),
      }),
    );
    const unownedDir = path.join(t3Home, "virtual-workspaces", "github", "manual-checkout");
    fs.mkdirSync(unownedDir, { recursive: true });

    const result = pruneVirtualWorkspaceCache({
      t3Home,
      activeCheckoutPaths: [checkoutDirs[0] as string],
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    expect(result).toEqual({ deleted: 2, kept: 11, errors: 0 });
    expect(fs.existsSync(checkoutDirs[0] as string)).toBe(true);
    expect(fs.existsSync(checkoutDirs[1] as string)).toBe(false);
    expect(fs.existsSync(checkoutDirs[2] as string)).toBe(false);
    expect(fs.existsSync(checkoutDirs[3] as string)).toBe(true);
    expect(fs.existsSync(checkoutDirs[12] as string)).toBe(true);
    expect(fs.existsSync(unownedDir)).toBe(true);
  });

  it("does not prune inactive checkouts that were used inside the retention window", () => {
    for (let index = 0; index < 10; index += 1) {
      createCacheEntry({
        t3Home,
        name: `recent-${index}`,
        lastUsedAt: new Date(Date.UTC(2026, 4, 14, index)).toISOString(),
      });
    }
    const staleCheckout = createCacheEntry({
      t3Home,
      name: "stale",
      lastUsedAt: "2026-04-01T10:00:00.000Z",
    });
    const freshCheckout = createCacheEntry({
      t3Home,
      name: "fresh",
      lastUsedAt: "2026-05-10T10:00:00.000Z",
    });

    const result = pruneVirtualWorkspaceCache({
      t3Home,
      now: new Date("2026-05-15T10:00:00.000Z"),
    });

    expect(result).toEqual({ deleted: 1, kept: 11, errors: 0 });
    expect(fs.existsSync(staleCheckout)).toBe(false);
    expect(fs.existsSync(freshCheckout)).toBe(true);
  });

  it("cleans all inactive cache-owned checkouts and keeps active or unowned directories", () => {
    const activeCheckout = createCacheEntry({
      t3Home,
      name: "active",
      lastUsedAt: "2026-04-01T10:00:00.000Z",
    });
    const inactiveCheckout = createCacheEntry({
      t3Home,
      name: "inactive",
      lastUsedAt: "2026-05-01T10:00:00.000Z",
    });
    const unownedDir = path.join(t3Home, "virtual-workspaces", "github", "manual-checkout");
    fs.mkdirSync(unownedDir, { recursive: true });

    const result = cleanVirtualWorkspaceCache({
      t3Home,
      activeCheckoutPaths: [activeCheckout],
    });

    expect(result).toEqual({ deleted: 1, kept: 1, errors: 0 });
    expect(fs.existsSync(activeCheckout)).toBe(true);
    expect(fs.existsSync(inactiveCheckout)).toBe(false);
    expect(fs.existsSync(unownedDir)).toBe(true);
  });
});

function createCacheEntry(input: {
  readonly t3Home: string;
  readonly name: string;
  readonly lastUsedAt: string;
}): string {
  const checkoutDir = path.join(input.t3Home, "virtual-workspaces", "github", input.name);
  fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
  writeMetadata(checkoutDir, {
    createdAt: input.lastUsedAt,
    lastUsedAt: input.lastUsedAt,
    lastBackendStartedAt: input.lastUsedAt,
    workspaceFolderKey: `vscode-vfs:github:/${input.name}`,
  });
  return checkoutDir;
}

function writeMetadata(
  checkoutDir: string,
  metadata: {
    readonly createdAt: string;
    readonly lastUsedAt: string;
    readonly lastBackendStartedAt: string;
    readonly workspaceFolderKey: string;
  },
): void {
  fs.mkdirSync(checkoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkoutDir, VIRTUAL_WORKSPACE_METADATA_FILE),
    `${JSON.stringify(
      {
        version: 1,
        provider: "github",
        cloneUrl: "https://github.com/example/repo.git",
        ...metadata,
      },
      null,
      2,
    )}\n`,
  );
}

function readMetadata(checkoutDir: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(checkoutDir, VIRTUAL_WORKSPACE_METADATA_FILE), "utf8"),
  );
}
