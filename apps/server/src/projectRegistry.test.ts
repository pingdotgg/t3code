import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRegistry } from "./projectRegistry";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ProjectRegistry scripts", () => {
  it("stores and reloads project scripts", () => {
    const stateDir = makeTempDir("t3code-project-registry-state-");
    const projectDir = makeTempDir("t3code-project-registry-project-");
    const registry = new ProjectRegistry(stateDir);

    const created = registry.add({ cwd: projectDir }).project;
    const updated = registry.updateScripts({
      id: created.id,
      scripts: [
        {
          id: "run",
          name: "Run",
          command: "bun run dev",
          icon: "play",
          runOnWorktreeCreate: false,
        },
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    });

    expect(updated.project.scripts).toHaveLength(2);
    expect(updated.project.scripts[1]?.id).toBe("setup");
    expect(updated.project.scripts[1]?.runOnWorktreeCreate).toBe(true);

    const reloaded = new ProjectRegistry(stateDir);
    const listed = reloaded.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.scripts).toHaveLength(2);
    expect(listed[0]?.scripts[0]?.id).toBe("run");
    expect(listed[0]?.scripts[1]?.id).toBe("setup");
  });

  it("deduplicates script ids and allows only one setup script", () => {
    const stateDir = makeTempDir("t3code-project-registry-state-");
    const projectDir = makeTempDir("t3code-project-registry-project-");
    const registry = new ProjectRegistry(stateDir);
    const created = registry.add({ cwd: projectDir }).project;

    const updated = registry.updateScripts({
      id: created.id,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "echo setup",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
        {
          id: "setup",
          name: "Setup Duplicate",
          command: "echo duplicate",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
        {
          id: "another",
          name: "Another Setup",
          command: "echo another",
          icon: "play",
          runOnWorktreeCreate: true,
        },
      ],
    });

    expect(updated.project.scripts).toHaveLength(2);
    expect(updated.project.scripts[0]?.id).toBe("setup");
    expect(updated.project.scripts[0]?.runOnWorktreeCreate).toBe(true);
    expect(updated.project.scripts[1]?.id).toBe("another");
    expect(updated.project.scripts[1]?.runOnWorktreeCreate).toBe(false);
  });

  it("throws when updating scripts for an unknown project id", () => {
    const stateDir = makeTempDir("t3code-project-registry-state-");
    const registry = new ProjectRegistry(stateDir);

    expect(() =>
      registry.updateScripts({
        id: "missing-project",
        scripts: [],
      }),
    ).toThrowError("Project not found");
  });
});
