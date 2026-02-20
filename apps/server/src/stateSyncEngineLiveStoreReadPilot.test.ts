import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  AppSettingsUpdateInput,
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRemoveInput,
  ProjectUpdateScriptsInput,
  ProjectUpdateScriptsResult,
  StateBootstrapResult,
  StateCatchUpInput,
  StateCatchUpResult,
  StateEvent,
  StateListMessagesInput,
  StateListMessagesResult,
  ThreadsCreateInput,
  ThreadsDeleteInput,
  ThreadsMarkVisitedInput,
  ThreadsUpdateBranchInput,
  ThreadsUpdateModelInput,
  ThreadsUpdateResult,
  ThreadsUpdateTerminalStateInput,
  ThreadsUpdateTitleInput,
} from "@t3tools/contracts";
import type { LiveStoreStateMirror } from "./livestore/liveStoreEngine";
import type { ApplyCheckpointRevertInput, StateSyncEngine } from "./stateSyncEngine";
import { LiveStoreReadPilotStateSyncEngine } from "./stateSyncEngineLiveStoreReadPilot";

class MockDelegateStateSyncEngine extends EventEmitter<{ stateEvent: [event: StateEvent] }>
  implements StateSyncEngine
{
  readonly loadSnapshotMock = vi.fn<() => StateBootstrapResult>(() => ({
    projects: [],
    threads: [],
    lastStateSeq: 1,
  }));
  readonly listMessagesMock = vi.fn<(raw: StateListMessagesInput) => StateListMessagesResult>(() => ({
    messages: [],
    total: 0,
    nextOffset: null,
  }));
  readonly catchUpMock = vi.fn<(raw: StateCatchUpInput) => StateCatchUpResult>(() => ({
    events: [],
    lastStateSeq: 1,
  }));
  readonly getAppSettingsMock = vi.fn<() => AppSettings>(() => ({
    codexBinaryPath: "",
    codexHomePath: "",
  }));
  readonly updateAppSettingsMock = vi.fn<(raw: AppSettingsUpdateInput) => AppSettings>(() => ({
    codexBinaryPath: "",
    codexHomePath: "",
  }));
  readonly createThreadMock = vi.fn<(raw: ThreadsCreateInput) => ThreadsUpdateResult>(() => {
    throw new Error("not implemented in test");
  });
  readonly updateThreadTerminalStateMock = vi.fn<
    (raw: ThreadsUpdateTerminalStateInput) => ThreadsUpdateResult
  >(() => {
    throw new Error("not implemented in test");
  });
  readonly updateThreadModelMock = vi.fn<(raw: ThreadsUpdateModelInput) => ThreadsUpdateResult>(() => {
    throw new Error("not implemented in test");
  });
  readonly updateThreadTitleMock = vi.fn<(raw: ThreadsUpdateTitleInput) => ThreadsUpdateResult>(() => {
    throw new Error("not implemented in test");
  });
  readonly updateThreadBranchMock = vi.fn<(raw: ThreadsUpdateBranchInput) => ThreadsUpdateResult>(() => {
    throw new Error("not implemented in test");
  });
  readonly markThreadVisitedMock = vi.fn<(raw: ThreadsMarkVisitedInput) => ThreadsUpdateResult>(() => {
    throw new Error("not implemented in test");
  });
  readonly deleteThreadMock = vi.fn<(raw: ThreadsDeleteInput) => void>(() => {});
  readonly listProjectsMock = vi.fn<() => ProjectListResult>(() => []);
  readonly addProjectMock = vi.fn<(raw: ProjectAddInput) => ProjectAddResult>(() => {
    throw new Error("not implemented in test");
  });
  readonly removeProjectMock = vi.fn<(raw: ProjectRemoveInput) => void>(() => {});
  readonly updateProjectScriptsMock = vi.fn<
    (raw: ProjectUpdateScriptsInput) => ProjectUpdateScriptsResult
  >(() => {
    throw new Error("not implemented in test");
  });
  readonly applyCheckpointRevertMock = vi.fn<(input: ApplyCheckpointRevertInput) => void>(() => {});
  readonly closeMock = vi.fn();

  onStateEvent(listener: (event: StateEvent) => void): () => void {
    this.on("stateEvent", listener);
    return () => {
      this.off("stateEvent", listener);
    };
  }

  emitStateEvent(event: StateEvent): void {
    this.emit("stateEvent", event);
  }

  loadSnapshot(): StateBootstrapResult {
    return this.loadSnapshotMock();
  }
  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    return this.listMessagesMock(raw);
  }
  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    return this.catchUpMock(raw);
  }
  getAppSettings(): AppSettings {
    return this.getAppSettingsMock();
  }
  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings {
    return this.updateAppSettingsMock(raw);
  }
  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult {
    return this.createThreadMock(raw);
  }
  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult {
    return this.updateThreadTerminalStateMock(raw);
  }
  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult {
    return this.updateThreadModelMock(raw);
  }
  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult {
    return this.updateThreadTitleMock(raw);
  }
  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult {
    return this.updateThreadBranchMock(raw);
  }
  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult {
    return this.markThreadVisitedMock(raw);
  }
  deleteThread(raw: ThreadsDeleteInput): void {
    this.deleteThreadMock(raw);
  }
  listProjects(): ProjectListResult {
    return this.listProjectsMock();
  }
  addProject(raw: ProjectAddInput): ProjectAddResult {
    return this.addProjectMock(raw);
  }
  removeProject(raw: ProjectRemoveInput): void {
    this.removeProjectMock(raw);
  }
  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    return this.updateProjectScriptsMock(raw);
  }
  applyCheckpointRevert(input: ApplyCheckpointRevertInput): void {
    this.applyCheckpointRevertMock(input);
  }
  close(): void {
    this.closeMock();
  }
}

function makeMirrorStub(input: {
  snapshot: StateBootstrapResult;
  catchUp: StateCatchUpResult;
  listMessages: StateListMessagesResult;
}): LiveStoreStateMirror {
  return {
    mirrorStateEvent: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    debugReadSnapshot: vi.fn(() => input.snapshot),
    debugCatchUp: vi.fn(() => input.catchUp),
    debugListMessages: vi.fn(() => input.listMessages),
  } as unknown as LiveStoreStateMirror;
}

describe("LiveStoreReadPilotStateSyncEngine", () => {
  it("serves bootstrap/catchUp/listMessages from mirror when available", () => {
    const delegate = new MockDelegateStateSyncEngine();
    const mirrorSnapshot: StateBootstrapResult = {
      projects: [],
      threads: [],
      lastStateSeq: 5,
    };
    const mirrorCatchUp: StateCatchUpResult = {
      events: [],
      lastStateSeq: 5,
    };
    const mirrorList: StateListMessagesResult = {
      messages: [],
      total: 0,
      nextOffset: null,
    };
    const mirror = makeMirrorStub({
      snapshot: mirrorSnapshot,
      catchUp: mirrorCatchUp,
      listMessages: mirrorList,
    });
    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
    });

    try {
      expect(engine.loadSnapshot()).toEqual(mirrorSnapshot);
      expect(engine.catchUp({ afterSeq: 0 })).toEqual(mirrorCatchUp);
      expect(engine.listMessages({ threadId: "thread-1", offset: 0, limit: 10 })).toEqual(mirrorList);
      expect(delegate.loadSnapshotMock).not.toHaveBeenCalled();
      expect(delegate.catchUpMock).not.toHaveBeenCalled();
      expect(delegate.listMessagesMock).not.toHaveBeenCalled();
      expect(engine.debugReadMetrics()).toEqual({
        routeReadCounts: {
          "state.bootstrap": { livestore: 1, delegate: 0 },
          "state.catchUp": { livestore: 1, delegate: 0 },
          "state.listMessages": { livestore: 1, delegate: 0 },
        },
        fallbackCounts: {
          "state.bootstrap": { "mirror-error": 0, "empty-mirror": 0 },
          "state.catchUp": { "mirror-error": 0, "empty-mirror": 0 },
          "state.listMessages": { "mirror-error": 0, "empty-mirror": 0 },
        },
      });
    } finally {
      engine.close();
    }
  });

  it("falls back to delegate reads when mirror throws", () => {
    const delegate = new MockDelegateStateSyncEngine();
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 2,
      },
      catchUp: {
        events: [],
        lastStateSeq: 2,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });
    vi.mocked(mirror.debugReadSnapshot).mockImplementationOnce(() => {
      throw new Error("mirror bootstrap failure");
    });
    vi.mocked(mirror.debugCatchUp).mockImplementationOnce(() => {
      throw new Error("mirror catch-up failure");
    });
    vi.mocked(mirror.debugListMessages).mockImplementationOnce(() => {
      throw new Error("mirror list failure");
    });

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
    });

    try {
      expect(engine.loadSnapshot()).toEqual({
        projects: [],
        threads: [],
        lastStateSeq: 1,
      });
      expect(engine.catchUp({ afterSeq: 0 })).toEqual({
        events: [],
        lastStateSeq: 1,
      });
      expect(engine.listMessages({ threadId: "thread-1", offset: 0, limit: 10 })).toEqual({
        messages: [],
        total: 0,
        nextOffset: null,
      });
      expect(delegate.loadSnapshotMock).toHaveBeenCalledTimes(1);
      expect(delegate.catchUpMock).toHaveBeenCalledTimes(1);
      expect(delegate.listMessagesMock).toHaveBeenCalledTimes(1);
      expect(engine.debugReadMetrics()).toEqual({
        routeReadCounts: {
          "state.bootstrap": { livestore: 0, delegate: 1 },
          "state.catchUp": { livestore: 0, delegate: 1 },
          "state.listMessages": { livestore: 0, delegate: 1 },
        },
        fallbackCounts: {
          "state.bootstrap": { "mirror-error": 1, "empty-mirror": 0 },
          "state.catchUp": { "mirror-error": 1, "empty-mirror": 0 },
          "state.listMessages": { "mirror-error": 1, "empty-mirror": 0 },
        },
      });
    } finally {
      engine.close();
    }
  });

  it("logs a warning when mirror reports unsuccessful event writes", async () => {
    const delegate = new MockDelegateStateSyncEngine();
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 1,
      },
      catchUp: {
        events: [],
        lastStateSeq: 1,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });
    vi.mocked(mirror.mirrorStateEvent).mockResolvedValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
    });

    try {
      delegate.emitStateEvent({
        seq: 1,
        eventType: "project.upsert",
        entityId: "project-1",
        payload: {},
        createdAt: "2026-02-20T00:00:00.000Z",
      });
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("mirror state event in read pilot reported unsuccessful write"),
      );
    } finally {
      warnSpy.mockRestore();
      engine.close();
    }
  });

  it("runs bootstrap parity check against delegate when enabled", () => {
    const delegate = new MockDelegateStateSyncEngine();
    delegate.loadSnapshotMock.mockReturnValue({
      projects: [],
      threads: [],
      lastStateSeq: 9,
    });
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 5,
      },
      catchUp: {
        events: [],
        lastStateSeq: 5,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
      enableBootstrapParityCheck: true,
    });

    try {
      expect(engine.loadSnapshot()).toEqual({
        projects: [],
        threads: [],
        lastStateSeq: 5,
      });
      // One call from the parity check path while mirror remains source.
      expect(delegate.loadSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      engine.close();
    }
  });

  it("runs catch-up parity check against delegate when enabled", () => {
    const delegate = new MockDelegateStateSyncEngine();
    delegate.catchUpMock.mockReturnValue({
      events: [],
      lastStateSeq: 11,
    });
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 5,
      },
      catchUp: {
        events: [],
        lastStateSeq: 7,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
      enableCatchUpParityCheck: true,
    });

    try {
      expect(engine.catchUp({ afterSeq: 3 })).toEqual({
        events: [],
        lastStateSeq: 7,
      });
      // One call from parity-check comparison path while mirror remains source.
      expect(delegate.catchUpMock).toHaveBeenCalledTimes(1);
      expect(delegate.catchUpMock).toHaveBeenCalledWith({ afterSeq: 3 });
    } finally {
      engine.close();
    }
  });

  it("runs list-messages parity check against delegate when enabled", () => {
    const delegate = new MockDelegateStateSyncEngine();
    delegate.listMessagesMock.mockReturnValue({
      messages: [],
      total: 2,
      nextOffset: 2,
    });
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 5,
      },
      catchUp: {
        events: [],
        lastStateSeq: 5,
      },
      listMessages: {
        messages: [],
        total: 1,
        nextOffset: null,
      },
    });

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
      enableListMessagesParityCheck: true,
    });

    try {
      expect(engine.listMessages({ threadId: "thread-1", offset: 0, limit: 10 })).toEqual({
        messages: [],
        total: 1,
        nextOffset: null,
      });
      // One call from parity-check comparison path while mirror remains source.
      expect(delegate.listMessagesMock).toHaveBeenCalledTimes(1);
      expect(delegate.listMessagesMock).toHaveBeenCalledWith({
        threadId: "thread-1",
        offset: 0,
        limit: 10,
      });
    } finally {
      engine.close();
    }
  });

  it("can disable delegate read fallback for strict mirror reads", () => {
    const delegate = new MockDelegateStateSyncEngine();
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 0,
      },
      catchUp: {
        events: [],
        lastStateSeq: 0,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });
    vi.mocked(mirror.debugReadSnapshot).mockImplementationOnce(() => {
      throw new Error("strict bootstrap failure");
    });
    vi.mocked(mirror.debugCatchUp).mockImplementationOnce(() => {
      throw new Error("strict catch-up failure");
    });
    vi.mocked(mirror.debugListMessages).mockImplementationOnce(() => {
      throw new Error("strict list failure");
    });

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
      disableDelegateReadFallback: true,
    });

    try {
      expect(() => engine.loadSnapshot()).toThrow(/strict bootstrap failure/);
      expect(() => engine.catchUp({ afterSeq: 0 })).toThrow(/strict catch-up failure/);
      expect(() => engine.listMessages({ threadId: "thread-1", offset: 0, limit: 10 })).toThrow(
        /strict list failure/,
      );
      expect(delegate.loadSnapshotMock).not.toHaveBeenCalled();
      expect(delegate.catchUpMock).not.toHaveBeenCalled();
      expect(delegate.listMessagesMock).not.toHaveBeenCalled();
    } finally {
      engine.close();
    }
  });

  it("uses mirror bootstrap even when seq is zero if fallback disabled", () => {
    const delegate = new MockDelegateStateSyncEngine();
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 0,
      },
      catchUp: {
        events: [],
        lastStateSeq: 0,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
      disableDelegateReadFallback: true,
    });

    try {
      expect(engine.loadSnapshot()).toEqual({
        projects: [],
        threads: [],
        lastStateSeq: 0,
      });
      expect(delegate.loadSnapshotMock).not.toHaveBeenCalled();
      expect(engine.debugReadMetrics()).toEqual({
        routeReadCounts: {
          "state.bootstrap": { livestore: 1, delegate: 0 },
          "state.catchUp": { livestore: 0, delegate: 0 },
          "state.listMessages": { livestore: 0, delegate: 0 },
        },
        fallbackCounts: {
          "state.bootstrap": { "mirror-error": 0, "empty-mirror": 0 },
          "state.catchUp": { "mirror-error": 0, "empty-mirror": 0 },
          "state.listMessages": { "mirror-error": 0, "empty-mirror": 0 },
        },
      });
    } finally {
      engine.close();
    }
  });

  it("returns to mirror reads after transient fallback errors", () => {
    const delegate = new MockDelegateStateSyncEngine();
    const mirror = makeMirrorStub({
      snapshot: {
        projects: [],
        threads: [],
        lastStateSeq: 5,
      },
      catchUp: {
        events: [],
        lastStateSeq: 5,
      },
      listMessages: {
        messages: [],
        total: 0,
        nextOffset: null,
      },
    });
    vi.mocked(mirror.debugCatchUp)
      .mockImplementationOnce(() => {
        throw new Error("mirror catch-up failure");
      })
      .mockImplementation(() => ({
        events: [],
        lastStateSeq: 5,
      }));
    vi.mocked(mirror.debugListMessages)
      .mockImplementationOnce(() => {
        throw new Error("mirror list failure");
      })
      .mockImplementation(() => ({
        messages: [],
        total: 0,
        nextOffset: null,
      }));

    const engine = new LiveStoreReadPilotStateSyncEngine({
      delegate,
      mirror,
    });

    try {
      expect(engine.catchUp({ afterSeq: 0 })).toEqual({
        events: [],
        lastStateSeq: 1,
      });
      expect(engine.listMessages({ threadId: "thread-1", offset: 0, limit: 10 })).toEqual({
        messages: [],
        total: 0,
        nextOffset: null,
      });
      expect(delegate.catchUpMock).toHaveBeenCalledTimes(1);
      expect(delegate.listMessagesMock).toHaveBeenCalledTimes(1);

      expect(engine.catchUp({ afterSeq: 0 })).toEqual({
        events: [],
        lastStateSeq: 5,
      });
      expect(engine.listMessages({ threadId: "thread-1", offset: 0, limit: 10 })).toEqual({
        messages: [],
        total: 0,
        nextOffset: null,
      });
      expect(delegate.catchUpMock).toHaveBeenCalledTimes(1);
      expect(delegate.listMessagesMock).toHaveBeenCalledTimes(1);
      expect(engine.debugReadMetrics()).toEqual({
        routeReadCounts: {
          "state.bootstrap": { livestore: 0, delegate: 0 },
          "state.catchUp": { livestore: 1, delegate: 1 },
          "state.listMessages": { livestore: 1, delegate: 1 },
        },
        fallbackCounts: {
          "state.bootstrap": { "mirror-error": 0, "empty-mirror": 0 },
          "state.catchUp": { "mirror-error": 1, "empty-mirror": 0 },
          "state.listMessages": { "mirror-error": 1, "empty-mirror": 0 },
        },
      });
    } finally {
      engine.close();
    }
  });
});
