import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateEvent } from "@t3tools/contracts";
import { diffStateSnapshots } from "./livestore/parity";
import { LiveStoreStateMirror } from "./livestore/liveStoreEngine";
import { PersistenceService } from "./persistenceService";
import { LegacyStateSyncEngine } from "./stateSyncEngineLegacy";
import type { StateEventMirror } from "./stateSyncEngineShadow";
import { ShadowStateSyncEngine } from "./stateSyncEngineShadow";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitForParity(
  getExpected: () => ReturnType<LegacyStateSyncEngine["loadSnapshot"]>,
  getMirrored: () => ReturnType<LiveStoreStateMirror["debugReadSnapshot"]>,
): Promise<void> {
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (diffStateSnapshots(getExpected(), getMirrored()).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  expect(diffStateSnapshots(getExpected(), getMirrored())).toEqual([]);
}

class CapturingMirror implements StateEventMirror {
  readonly events: StateEvent[] = [];
  disposeCalls = 0;

  async mirrorStateEvent(event: StateEvent): Promise<void> {
    this.events.push(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ShadowStateSyncEngine", () => {
  it("delegates durable APIs and mirrors emitted state events", async () => {
    const stateDir = makeTempDir("t3code-shadow-state-");
    const projectDir = makeTempDir("t3code-shadow-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new CapturingMirror();
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      const observedEvents: StateEvent[] = [];
      const unsubscribe = shadow.onStateEvent((event) => {
        observedEvents.push(event);
      });

      const project = shadow.addProject({ cwd: projectDir }).project;
      const thread = shadow.createThread({
        projectId: project.id,
        title: "Shadow thread",
      }).thread;
      shadow.updateThreadTitle({
        threadId: thread.id,
        title: "Shadow thread updated",
      });
      service.bindSessionToThread("shadow-session", thread.id, "runtime-thread-1");
      service.persistUserMessageForTurn({
        sessionId: "shadow-session",
        clientMessageId: "msg-1",
        clientMessageText: "hello from shadow",
        input: "hello from shadow",
        attachments: [],
      });

      await Promise.resolve();

      const snapshot = shadow.loadSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.title).toBe("Shadow thread updated");

      const catchUp = shadow.catchUp({ afterSeq: 0 });
      expect(catchUp.events.length).toBeGreaterThan(0);
      expect(catchUp.events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["project.upsert", "thread.upsert"]),
      );

      expect(mirror.events.map((event) => event.seq)).toEqual(
        observedEvents.map((event) => event.seq),
      );
      expect(mirror.events.some((event) => event.eventType === "message.upsert")).toBe(true);
      expect(observedEvents.some((event) => event.eventType === "message.upsert")).toBe(true);

      unsubscribe();
    } finally {
      shadow.close();
      service.close();
    }
  });

  it("stops mirroring and disposes once on close", async () => {
    const stateDir = makeTempDir("t3code-shadow-close-state-");
    const projectDir = makeTempDir("t3code-shadow-close-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new CapturingMirror();
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      shadow.close();
      shadow.close();

      legacy.addProject({ cwd: projectDir });
      await Promise.resolve();
      expect(mirror.events).toHaveLength(0);
      expect(mirror.disposeCalls).toBe(1);
    } finally {
      service.close();
    }
  });

  it("logs a warning when mirror reports unsuccessful writes", async () => {
    const stateDir = makeTempDir("t3code-shadow-unsuccessful-write-state-");
    const projectDir = makeTempDir("t3code-shadow-unsuccessful-write-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mirror: StateEventMirror = {
      mirrorStateEvent: async () => false,
      dispose: async () => undefined,
    };
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      shadow.addProject({ cwd: projectDir });
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("livestore shadow mirror reported unsuccessful write"),
      );
    } finally {
      warnSpy.mockRestore();
      shadow.close();
      service.close();
    }
  });

  it("keeps LiveStore mirror snapshot in parity with delegate writes", async () => {
    const stateDir = makeTempDir("t3code-shadow-parity-state-");
    const projectDir = makeTempDir("t3code-shadow-parity-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new LiveStoreStateMirror({ storeId: "shadow-parity-engine-test" });
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      const project = shadow.addProject({ cwd: projectDir }).project;
      const thread = shadow.createThread({
        projectId: project.id,
        title: "Parity thread",
      }).thread;
      service.bindSessionToThread("parity-session", thread.id, "runtime-thread-parity");
      service.persistUserMessageForTurn({
        sessionId: "parity-session",
        clientMessageId: "parity-message-1",
        clientMessageText: "hello parity",
        input: "hello parity",
        attachments: [],
      });

      await waitForParity(() => legacy.loadSnapshot(), () => mirror.debugReadSnapshot());
    } finally {
      shadow.close();
      service.close();
    }
  });

  it("can run optional bootstrap parity diagnostics without changing read results", () => {
    const stateDir = makeTempDir("t3code-shadow-parity-diagnostics-state-");
    const projectDir = makeTempDir("t3code-shadow-parity-diagnostics-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const debugReadSnapshot = vi.fn(() => ({
      projects: [],
      threads: [],
      lastStateSeq: 0,
    }));
    const mirror: StateEventMirror = {
      mirrorStateEvent: async () => undefined,
      debugReadSnapshot,
      dispose: async () => undefined,
    };
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
      enableBootstrapParityCheck: true,
    });

    try {
      legacy.addProject({ cwd: projectDir });
      const snapshot = shadow.loadSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(debugReadSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      shadow.close();
      service.close();
    }
  });

  it("can run optional catch-up and list-messages parity diagnostics", () => {
    const stateDir = makeTempDir("t3code-shadow-parity-diagnostics-reads-state-");
    const projectDir = makeTempDir("t3code-shadow-parity-diagnostics-reads-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const debugCatchUp = vi.fn((afterSeq: number) => ({
      events: [],
      lastStateSeq: afterSeq,
    }));
    const debugListMessages = vi.fn(() => ({
      messages: [],
      total: 0,
      nextOffset: null,
    }));
    const mirror: StateEventMirror = {
      mirrorStateEvent: async () => undefined,
      debugCatchUp,
      debugListMessages,
      dispose: async () => undefined,
    };
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
      enableCatchUpParityCheck: true,
      enableListMessagesParityCheck: true,
    });

    try {
      const project = shadow.addProject({ cwd: projectDir }).project;
      const thread = shadow.createThread({
        projectId: project.id,
        title: "Shadow parity read diagnostics thread",
      }).thread;

      const catchUp = shadow.catchUp({ afterSeq: 0 });
      expect(catchUp.events.length).toBeGreaterThan(0);
      const listed = shadow.listMessages({ threadId: thread.id, offset: 0, limit: 10 });
      expect(listed).toEqual({
        messages: [],
        total: 0,
        nextOffset: null,
      });

      expect(debugCatchUp).toHaveBeenCalledTimes(1);
      expect(debugCatchUp).toHaveBeenCalledWith(0);
      expect(debugListMessages).toHaveBeenCalledTimes(1);
      expect(debugListMessages).toHaveBeenCalledWith({
        threadId: thread.id,
        offset: 0,
        limit: 10,
      });
    } finally {
      shadow.close();
      service.close();
    }
  });
});
