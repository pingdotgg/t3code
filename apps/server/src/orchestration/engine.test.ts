import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEngine } from "./engine";

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

describe("OrchestrationEngine", () => {
  it("replays to the same deterministic snapshot", async () => {
    const stateDir = makeTempDir("t3code-orchestration-");
    const createdAt = new Date().toISOString();
    const projectId = "project-1";
    const threadId = "thread-1";

    const engineA = new OrchestrationEngine(stateDir);
    await engineA.start();
    await engineA.dispatch({
      type: "project.create",
      commandId: "cmd-1",
      projectId,
      name: "demo",
      cwd: "/tmp/demo",
      model: "gpt-5-codex",
      createdAt,
    });
    await engineA.dispatch({
      type: "thread.create",
      commandId: "cmd-2",
      threadId,
      projectId,
      title: "Thread",
      model: "gpt-5-codex",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await engineA.dispatch({
      type: "message.send",
      commandId: "cmd-3",
      threadId,
      messageId: "msg-1",
      role: "user",
      text: "hello",
      streaming: false,
      createdAt,
    });
    const snapshotA = engineA.getSnapshot();
    await engineA.stop();

    const engineB = new OrchestrationEngine(stateDir);
    await engineB.start();
    const snapshotB = engineB.getSnapshot();
    expect(snapshotB).toEqual(snapshotA);
    await engineB.stop();
  });

  it("fans out read-model updates to subscribers", async () => {
    const stateDir = makeTempDir("t3code-orchestration-fanout-");
    const engine = new OrchestrationEngine(stateDir);
    await engine.start();
    const updates: number[] = [];
    const unsubscribe = engine.subscribeToReadModel((snapshot) => {
      updates.push(snapshot.sequence);
    });
    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-project",
      projectId: "project-2",
      name: "fanout",
      cwd: "/tmp/fanout",
      model: "gpt-5-codex",
      createdAt: new Date().toISOString(),
    });
    unsubscribe();
    expect(updates.length).toBeGreaterThan(0);
    await engine.stop();
  });

  it("replays append-only events from sequence", async () => {
    const stateDir = makeTempDir("t3code-orchestration-replay-");
    const engine = new OrchestrationEngine(stateDir);
    await engine.start();
    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-a",
      projectId: "project-replay",
      name: "replay",
      cwd: "/tmp/replay",
      model: "gpt-5-codex",
      createdAt: new Date().toISOString(),
    });
    await engine.dispatch({
      type: "project.delete",
      commandId: "cmd-b",
      projectId: "project-replay",
      createdAt: new Date().toISOString(),
    });
    const events = await engine.replayEvents(0);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("project.created");
    expect(events[1]?.type).toBe("project.deleted");
    await engine.stop();
  });
});
