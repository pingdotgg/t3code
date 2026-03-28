import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectWorkspacePackages,
  ensureWorkspaceLink,
  expandWorkspacePattern,
} from "./lib/workspace-links.mjs";

const tempDirectories: string[] = [];

async function makeRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), "tero-workspace-links-"));
  tempDirectories.push(root);
  return root;
}

describe("workspace link helpers", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories
        .splice(0, tempDirectories.length)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("expands wildcard workspace patterns deterministically", async () => {
    const repoRoot = await makeRepoFixture();
    await mkdir(join(repoRoot, "apps", "desktop"), { recursive: true });
    await mkdir(join(repoRoot, "apps", "web"), { recursive: true });

    expect(await expandWorkspacePattern(repoRoot, "apps/*")).toEqual([
      join(repoRoot, "apps", "desktop"),
      join(repoRoot, "apps", "web"),
    ]);
  });

  it("collects workspace packages from configured patterns", async () => {
    const repoRoot = await makeRepoFixture();
    await mkdir(join(repoRoot, "apps", "server"), { recursive: true });
    await mkdir(join(repoRoot, "packages", "shared"), { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({
        workspaces: {
          packages: ["apps/*", "packages/*"],
        },
      }),
    );
    await writeFile(
      join(repoRoot, "apps", "server", "package.json"),
      JSON.stringify({ name: "tero" }),
    );
    await writeFile(
      join(repoRoot, "packages", "shared", "package.json"),
      JSON.stringify({ name: "@tero/shared" }),
    );

    expect(await collectWorkspacePackages(repoRoot)).toEqual([
      { name: "@tero/shared", directory: join(repoRoot, "packages", "shared") },
      { name: "tero", directory: join(repoRoot, "apps", "server") },
    ]);
  });

  it("rejects duplicate workspace package names", async () => {
    const repoRoot = await makeRepoFixture();
    await mkdir(join(repoRoot, "apps", "server"), { recursive: true });
    await mkdir(join(repoRoot, "packages", "server"), { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({
        workspaces: {
          packages: ["apps/*", "packages/*"],
        },
      }),
    );
    await writeFile(
      join(repoRoot, "apps", "server", "package.json"),
      JSON.stringify({ name: "tero" }),
    );
    await writeFile(
      join(repoRoot, "packages", "server", "package.json"),
      JSON.stringify({ name: "tero" }),
    );

    await expect(collectWorkspacePackages(repoRoot)).rejects.toThrow(
      'Duplicate workspace package name "tero"',
    );
  });

  it("creates or repairs workspace symlinks under node_modules", async () => {
    const repoRoot = await makeRepoFixture();
    const packageDirectory = join(repoRoot, "packages", "shared");
    const rootNodeModulesDir = join(repoRoot, "node_modules");
    const destination = join(rootNodeModulesDir, "@tero", "shared");

    await mkdir(packageDirectory, { recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    await symlink(relative(dirname(destination), join(repoRoot, "wrong-target")), destination);

    await ensureWorkspaceLink({
      rootNodeModulesDir,
      name: "@tero/shared",
      directory: packageDirectory,
    });

    expect(await realpath(destination)).toBe(await realpath(packageDirectory));
  });
});
