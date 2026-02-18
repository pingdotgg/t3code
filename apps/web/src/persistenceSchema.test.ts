import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL } from "./model-logic";
import { hydratePersistedState, toPersistedState } from "./persistenceSchema";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID } from "./types";
import type { Thread } from "./types";

describe("hydratePersistedState", () => {
  it("returns null for invalid payloads", () => {
    expect(hydratePersistedState('{"projects":"bad"}', false)).toBeNull();
    expect(hydratePersistedState("not-json", false)).toBeNull();
  });

  it("migrates the legacy default model to the current default", () => {
    const payload = JSON.stringify({
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.2-codex",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [
        {
          id: "t-1",
          projectId: "p-1",
          title: "Thread",
          model: "gpt-5.2-codex",
          messages: [
            {
              id: "m-1",
              role: "assistant",
              text: "Hello",
              createdAt: "2026-02-08T10:00:00.000Z",
              streaming: true,
            },
          ],
          createdAt: "2026-02-08T10:00:00.000Z",
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, true);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.projects[0]?.model).toBe(DEFAULT_MODEL);
    expect(hydrated?.threads[0]?.model).toBe(DEFAULT_MODEL);
    expect(hydrated?.threads[0]?.codexThreadId).toBeNull();
    expect(hydrated?.threads[0]?.terminalOpen).toBe(false);
    expect(hydrated?.threads[0]?.terminalHeight).toBe(DEFAULT_THREAD_TERMINAL_HEIGHT);
    expect(hydrated?.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    expect(hydrated?.threads[0]?.activeTerminalId).toBe(DEFAULT_THREAD_TERMINAL_ID);
    expect(hydrated?.threads[0]?.terminalGroups).toEqual([
      { id: `group-${DEFAULT_THREAD_TERMINAL_ID}`, terminalIds: [DEFAULT_THREAD_TERMINAL_ID] },
    ]);
    expect(hydrated?.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
    expect(hydrated?.threads[0]?.messages[0]?.streaming).toBe(false);
    expect(hydrated?.runtimeMode).toBe("full-access");
  });

  it("filters unknown project references and repairs active thread", () => {
    const payload = JSON.stringify({
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: false,
          scripts: [],
        },
      ],
      threads: [
        {
          id: "t-1",
          projectId: "p-1",
          title: "Valid thread",
          model: "gpt-5.3-codex",
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
        },
        {
          id: "t-2",
          projectId: "p-missing",
          title: "Dangling thread",
          model: "gpt-5.3-codex",
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
        },
      ],
      activeThreadId: "t-2",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.threads.map((thread) => thread.id)).toEqual(["t-1"]);
    expect(hydrated?.threads[0]?.codexThreadId).toBeNull();
    expect(hydrated?.threads[0]?.terminalOpen).toBe(false);
    expect(hydrated?.threads[0]?.terminalHeight).toBe(DEFAULT_THREAD_TERMINAL_HEIGHT);
    expect(hydrated?.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    expect(hydrated?.threads[0]?.activeTerminalId).toBe(DEFAULT_THREAD_TERMINAL_ID);
    expect(hydrated?.threads[0]?.terminalGroups).toEqual([
      { id: `group-${DEFAULT_THREAD_TERMINAL_ID}`, terminalIds: [DEFAULT_THREAD_TERMINAL_ID] },
    ]);
    expect(hydrated?.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
    expect(hydrated?.activeThreadId).toBe("t-1");
    expect(hydrated?.runtimeMode).toBe("full-access");
  });

  it("hydrates runtime mode from v3 payload", () => {
    const payload = JSON.stringify({
      version: 3,
      runtimeMode: "approval-required",
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: false,
          scripts: [],
        },
      ],
      threads: [],
      activeThreadId: null,
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.runtimeMode).toBe("approval-required");
  });

  it("hydrates terminal fields from legacy v6 payload", () => {
    const payload = JSON.stringify({
      version: 6,
      runtimeMode: "full-access",
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [
        {
          id: "t-1",
          codexThreadId: null,
          projectId: "p-1",
          title: "Thread",
          model: "gpt-5.3-codex",
          terminalOpen: true,
          terminalHeight: 360,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
          activeTerminalId: "term-2",
          terminalLayout: "tabs",
          splitTerminalIds: [],
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
          lastVisitedAt: "2026-02-08T10:01:00.000Z",
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.threads[0]?.terminalOpen).toBe(true);
    expect(hydrated?.threads[0]?.terminalHeight).toBe(360);
    expect(hydrated?.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-2"]);
    expect(hydrated?.threads[0]?.activeTerminalId).toBe("term-2");
    expect(hydrated?.threads[0]?.terminalGroups).toEqual([
      { id: `group-${DEFAULT_THREAD_TERMINAL_ID}`, terminalIds: [DEFAULT_THREAD_TERMINAL_ID] },
      { id: "group-term-2", terminalIds: ["term-2"] },
    ]);
    expect(hydrated?.threads[0]?.activeTerminalGroupId).toBe("group-term-2");
    expect(hydrated?.threads[0]?.lastVisitedAt).toBe("2026-02-08T10:01:00.000Z");
  });

  it("hydrates legacy split layout into a grouped split", () => {
    const payload = JSON.stringify({
      version: 6,
      runtimeMode: "full-access",
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [
        {
          id: "t-1",
          codexThreadId: null,
          projectId: "p-1",
          title: "Thread",
          model: "gpt-5.3-codex",
          terminalOpen: true,
          terminalHeight: 360,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2", "term-3"],
          activeTerminalId: "term-2",
          terminalLayout: "split",
          splitTerminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.threads[0]?.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
      },
      { id: "group-term-3", terminalIds: ["term-3"] },
    ]);
    expect(hydrated?.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
  });

  it("defaults terminalHeight when hydrating v5 payloads", () => {
    const payload = JSON.stringify({
      version: 5,
      runtimeMode: "full-access",
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [
        {
          id: "t-1",
          codexThreadId: null,
          projectId: "p-1",
          title: "Thread",
          model: "gpt-5.3-codex",
          terminalOpen: true,
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.threads[0]?.terminalHeight).toBe(DEFAULT_THREAD_TERMINAL_HEIGHT);
    expect(hydrated?.threads[0]?.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    expect(hydrated?.threads[0]?.activeTerminalId).toBe(DEFAULT_THREAD_TERMINAL_ID);
    expect(hydrated?.threads[0]?.terminalGroups).toEqual([
      { id: `group-${DEFAULT_THREAD_TERMINAL_ID}`, terminalIds: [DEFAULT_THREAD_TERMINAL_ID] },
    ]);
    expect(hydrated?.threads[0]?.activeTerminalGroupId).toBe(`group-${DEFAULT_THREAD_TERMINAL_ID}`);
  });

  it("hydrates persisted turn diff summaries and clears persisted loaded flags", () => {
    const payload = JSON.stringify({
      version: 7,
      runtimeMode: "full-access",
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
      threads: [
        {
          id: "t-1",
          codexThreadId: "thr_1",
          projectId: "p-1",
          title: "Thread",
          model: "gpt-5.3-codex",
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
          turnDiffSummaries: [
            {
              turnId: "turn-1",
              completedAt: "2026-02-08T10:05:00.000Z",
              checkpointTurnCount: 1,
              checkpointDiffLoaded: true,
              files: [
                {
                  path: "src/app.ts",
                  kind: "modified",
                  additions: 3,
                  deletions: 1,
                },
              ],
            },
          ],
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.threads[0]?.turnDiffSummaries).toEqual([
      {
        turnId: "turn-1",
        completedAt: "2026-02-08T10:05:00.000Z",
        checkpointTurnCount: 1,
        files: [
          {
            path: "src/app.ts",
            kind: "modified",
            additions: 3,
            deletions: 1,
          },
        ],
      },
    ]);
  });

  it("drops malformed persisted turn diff summaries instead of rejecting the whole snapshot", () => {
    const payload = JSON.stringify({
      version: 7,
      runtimeMode: "full-access",
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
      threads: [
        {
          id: "t-1",
          codexThreadId: "thr_1",
          projectId: "p-1",
          title: "Thread",
          model: "gpt-5.3-codex",
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
          turnDiffSummaries: [
            {
              turnId: "turn-1",
              completedAt: "2026-02-08T10:05:00.000Z",
              files: [{ path: 123 }],
            },
          ],
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.threads[0]?.id).toBe("t-1");
    expect(hydrated?.threads[0]?.turnDiffSummaries).toEqual([]);
  });
});

describe("toPersistedState", () => {
  it("writes v7 payload and strips non-persisted thread fields", () => {
    const thread: Thread = {
      id: "t-1",
      codexThreadId: "thr_1",
      projectId: "p-1",
      title: "Thread",
      model: "gpt-5.3-codex",
      terminalOpen: true,
      terminalHeight: 320,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
      runningTerminalIds: [],
      activeTerminalId: "term-2",
      terminalGroups: [
        { id: `group-${DEFAULT_THREAD_TERMINAL_ID}`, terminalIds: [DEFAULT_THREAD_TERMINAL_ID] },
        { id: "group-term-2", terminalIds: ["term-2"] },
      ],
      activeTerminalGroupId: "group-term-2",
      session: null,
      messages: [
        {
          id: "m-1",
          role: "user",
          text: "Hi",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 4_096,
              previewUrl: "blob:preview-1",
            },
          ],
          createdAt: "2026-02-08T10:00:00.000Z",
          streaming: false,
        },
      ],
      events: [],
      error: "boom",
      createdAt: "2026-02-08T10:00:00.000Z",
      lastVisitedAt: "2026-02-08T10:02:00.000Z",
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [
        {
          turnId: "turn-1",
          completedAt: "2026-02-08T10:05:00.000Z",
          status: "completed",
          checkpointTurnCount: 1,
          files: [
            {
              path: "src/app.ts",
              kind: "modified",
              additions: 3,
              deletions: 1,
              diff: "diff --git a/src/app.ts b/src/app.ts",
            },
          ],
          unifiedDiff: "diff --git a/src/app.ts b/src/app.ts",
        },
      ],
    };

    const persisted = toPersistedState({
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [thread],
      activeThreadId: "t-1",
      runtimeMode: "full-access",
    });

    expect(persisted.version).toBe(7);
    expect(persisted.runtimeMode).toBe("full-access");
    expect(persisted.threads[0]).toEqual({
      id: "t-1",
      codexThreadId: "thr_1",
      projectId: "p-1",
      title: "Thread",
      model: "gpt-5.3-codex",
      terminalOpen: true,
      terminalHeight: 320,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "term-2"],
      activeTerminalId: "term-2",
      terminalGroups: [
        { id: `group-${DEFAULT_THREAD_TERMINAL_ID}`, terminalIds: [DEFAULT_THREAD_TERMINAL_ID] },
        { id: "group-term-2", terminalIds: ["term-2"] },
      ],
      activeTerminalGroupId: "group-term-2",
      messages: [
        {
          id: "m-1",
          role: "user",
          text: "Hi",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 4_096,
            },
          ],
          createdAt: "2026-02-08T10:00:00.000Z",
          streaming: false,
        },
      ],
      createdAt: thread.createdAt,
      lastVisitedAt: thread.lastVisitedAt,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [
        {
          turnId: "turn-1",
          completedAt: "2026-02-08T10:05:00.000Z",
          status: "completed",
          checkpointTurnCount: 1,
          files: [
            {
              path: "src/app.ts",
              kind: "modified",
              additions: 3,
              deletions: 1,
            },
          ],
        },
      ],
    });
    const persistedThread = persisted.threads[0];
    expect(persistedThread).toBeDefined();
    if (!persistedThread) return;

    expect("error" in persistedThread).toBe(false);
    expect("session" in persistedThread).toBe(false);
  });
});
