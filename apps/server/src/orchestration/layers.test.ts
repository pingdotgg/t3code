import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrchestrationSystem } from "./runtime";

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

describe("orchestration layers", () => {
  it("creates an engine through Context.Tag wiring", async () => {
    const stateDir = makeTempDir("t3code-orchestration-layer-");
    const createdAt = new Date().toISOString();
    const firstSystem = await createOrchestrationSystem(stateDir);
    const { engine } = firstSystem;

    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-layer-1",
      projectId: "project-layer-1",
      name: "layer",
      cwd: "/tmp/layer",
      model: "gpt-5-codex",
      createdAt,
    });
    const firstSnapshot = engine.getSnapshot();
    await firstSystem.dispose();

    const secondSystem = await createOrchestrationSystem(stateDir);
    const restarted = secondSystem.engine;
    expect(restarted.getSnapshot()).toEqual(firstSnapshot);
    await secondSystem.dispose();
  });
});
