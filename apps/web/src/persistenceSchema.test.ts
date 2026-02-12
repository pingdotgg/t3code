import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL } from "./model-logic";
import { hydratePersistedState, toPersistedState } from "./persistenceSchema";
import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "./types";
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
        },
      ],
      threads: [],
      activeThreadId: null,
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.runtimeMode).toBe("approval-required");
  });

  it("hydrates terminal fields from v6 payload", () => {
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
          messages: [],
          createdAt: "2026-02-08T10:00:00.000Z",
        },
      ],
      activeThreadId: "t-1",
    });

    const hydrated = hydratePersistedState(payload, false);
    expect(hydrated?.threads[0]?.terminalOpen).toBe(true);
    expect(hydrated?.threads[0]?.terminalHeight).toBe(360);
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
  });
});

describe("toPersistedState", () => {
  it("writes v6 payload and strips non-persisted thread fields", () => {
    const thread: Thread = {
      id: "t-1",
      codexThreadId: "thr_1",
      projectId: "p-1",
      title: "Thread",
      model: "gpt-5.3-codex",
      terminalOpen: true,
      terminalHeight: 320,
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
      branch: null,
      worktreePath: null,
    };

    const persisted = toPersistedState({
      projects: [
        {
          id: "p-1",
          name: "Project",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
      threads: [thread],
      activeThreadId: "t-1",
      runtimeMode: "full-access",
    });

    expect(persisted.version).toBe(6);
    expect(persisted.runtimeMode).toBe("full-access");
    expect(persisted.threads[0]).toEqual({
      id: "t-1",
      codexThreadId: "thr_1",
      projectId: "p-1",
      title: "Thread",
      model: "gpt-5.3-codex",
      terminalOpen: true,
      terminalHeight: 320,
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
      branch: null,
      worktreePath: null,
    });
    const persistedThread = persisted.threads[0];
    expect(persistedThread).toBeDefined();
    if (!persistedThread) return;

    expect("error" in persistedThread).toBe(false);
    expect("session" in persistedThread).toBe(false);
  });
});
