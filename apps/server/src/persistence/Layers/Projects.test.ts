import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectRepository } from "../Services/Projects.ts";
import { ProjectRepositoryLive } from "./Projects.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

function makeProjectRepositoryTest(dbPath: string) {
  return ProjectRepositoryLive.pipe(Layer.provide(makeSqlitePersistenceLive(dbPath)));
}

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

describe("ProjectRepository", () => {
  it("persists projects and deduplicates adds by cwd", async () => {
    const stateDir = makeTempDir("t3code-project-repo-state-");
    const projectDir = makeTempDir("t3code-project-repo-project-");
    const dbPath = path.join(stateDir, "orchestration.sqlite");

    const firstRuntime = ManagedRuntime.make(makeProjectRepositoryTest(dbPath));
    const first = await firstRuntime.runPromise(Effect.service(ProjectRepository));

    const created = await firstRuntime.runPromise(first.add({ cwd: projectDir }));
    expect(created.created).toBe(true);

    const duplicate = await firstRuntime.runPromise(first.add({ cwd: projectDir }));
    expect(duplicate.created).toBe(false);
    expect(duplicate.project.id).toBe(created.project.id);

    await firstRuntime.dispose();

    const secondRuntime = ManagedRuntime.make(makeProjectRepositoryTest(dbPath));
    const second = await secondRuntime.runPromise(Effect.service(ProjectRepository));
    const listed = await secondRuntime.runPromise(second.list());

    expect(listed).toHaveLength(1);
    expect(listed[0]?.cwd).toBe(projectDir);

    await secondRuntime.dispose();
  });

  it("prunes missing project paths", async () => {
    const stateDir = makeTempDir("t3code-project-repo-prune-state-");
    const existing = makeTempDir("t3code-project-repo-prune-existing-");
    const missing = makeTempDir("t3code-project-repo-prune-missing-");
    const dbPath = path.join(stateDir, "orchestration.sqlite");

    const runtime = ManagedRuntime.make(makeProjectRepositoryTest(dbPath));
    const repository = await runtime.runPromise(Effect.service(ProjectRepository));

    const existingProject = await runtime.runPromise(repository.add({ cwd: existing }));
    const missingProject = await runtime.runPromise(repository.add({ cwd: missing }));

    expect(existingProject.created).toBe(true);
    expect(missingProject.created).toBe(true);

    fs.rmSync(missing, { recursive: true, force: true });

    await runtime.runPromise(repository.pruneMissing());
    const listed = await runtime.runPromise(repository.list());

    expect(listed).toHaveLength(1);
    expect(listed[0]?.cwd).toBe(existing);

    await runtime.dispose();
  });
});
