import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  navigateComposerPromptHistory,
  resolveComposerPromptHistoryEntries,
  resolveComposerPromptRecall,
} from "./composerPromptHistory";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Project,
  type Thread,
} from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1" as ChatMessage["id"],
    role: "user",
    text: "latest prompt",
    createdAt: "2026-03-16T10:00:00.000Z",
    streaming: false,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-16T09:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("resolveComposerPromptRecall", () => {
  it("prefers the latest sent user message in the current thread", () => {
    const currentThreadMessages = [
      makeMessage({
        id: "message-1" as ChatMessage["id"],
        text: "older current thread prompt",
        createdAt: "2026-03-16T09:00:00.000Z",
      }),
      makeMessage({
        id: "message-2" as ChatMessage["id"],
        role: "assistant",
        text: "assistant reply",
        createdAt: "2026-03-16T09:01:00.000Z",
      }),
      makeMessage({
        id: "message-3" as ChatMessage["id"],
        text: "current thread prompt",
        createdAt: "2026-03-16T09:02:00.000Z",
      }),
    ];

    const recalled = resolveComposerPromptRecall({
      currentProjectId: ProjectId.makeUnsafe("project-1"),
      currentThreadMessages,
      projects: [makeProject()],
      threads: [
        makeThread({
          messages: [
            makeMessage({
              id: "message-4" as ChatMessage["id"],
              text: "other thread prompt",
              createdAt: "2026-03-16T10:00:00.000Z",
            }),
          ],
        }),
      ],
    });

    expect(recalled).toBe("current thread prompt");
  });

  it("falls back to the latest user message from the same project when the current thread is new", () => {
    const recalled = resolveComposerPromptRecall({
      currentProjectId: ProjectId.makeUnsafe("project-1"),
      currentThreadMessages: [],
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-older"),
          messages: [
            makeMessage({
              id: "message-1" as ChatMessage["id"],
              text: "older repo prompt",
              createdAt: "2026-03-16T08:00:00.000Z",
            }),
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          messages: [
            makeMessage({
              id: "message-2" as ChatMessage["id"],
              text: "latest repo prompt",
              createdAt: "2026-03-16T11:00:00.000Z",
            }),
          ],
        }),
      ],
    });

    expect(recalled).toBe("latest repo prompt");
  });

  it("keeps the fallback repo-scoped instead of using other projects", () => {
    const recalled = resolveComposerPromptRecall({
      currentProjectId: ProjectId.makeUnsafe("project-1"),
      currentThreadMessages: [],
      projects: [
        makeProject(),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          cwd: "/tmp/other-project",
        }),
      ],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-same-project"),
          messages: [
            makeMessage({
              id: "message-1" as ChatMessage["id"],
              text: "same repo prompt",
              createdAt: "2026-03-16T10:00:00.000Z",
            }),
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: ProjectId.makeUnsafe("project-2"),
          messages: [
            makeMessage({
              id: "message-2" as ChatMessage["id"],
              text: "other repo prompt",
              createdAt: "2026-03-16T11:00:00.000Z",
            }),
          ],
        }),
      ],
    });

    expect(recalled).toBe("same repo prompt");
  });

  it("ignores assistant messages and internal bootstrap prompts", () => {
    const recalled = resolveComposerPromptRecall({
      currentProjectId: ProjectId.makeUnsafe("project-1"),
      currentThreadMessages: [],
      projects: [makeProject()],
      threads: [
        makeThread({
          messages: [
            makeMessage({
              id: "message-1" as ChatMessage["id"],
              role: "assistant",
              text: "assistant reply",
              createdAt: "2026-03-16T10:00:00.000Z",
            }),
            makeMessage({
              id: "message-2" as ChatMessage["id"],
              text: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
              createdAt: "2026-03-16T11:00:00.000Z",
            }),
            makeMessage({
              id: "message-3" as ChatMessage["id"],
              text: "real prompt",
              createdAt: "2026-03-16T09:00:00.000Z",
            }),
          ],
        }),
      ],
      ignoredMessageTexts: [
        "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
      ],
    });

    expect(recalled).toBe("real prompt");
  });
});

describe("resolveComposerPromptHistoryEntries", () => {
  it("returns current-thread entries newest first", () => {
    const entries = resolveComposerPromptHistoryEntries({
      currentProjectId: ProjectId.makeUnsafe("project-1"),
      currentThreadMessages: [
        makeMessage({
          id: "message-1" as ChatMessage["id"],
          text: "one",
          createdAt: "2026-03-16T09:00:00.000Z",
        }),
        makeMessage({
          id: "message-2" as ChatMessage["id"],
          text: "two",
          createdAt: "2026-03-16T10:00:00.000Z",
        }),
        makeMessage({
          id: "message-3" as ChatMessage["id"],
          text: "three",
          createdAt: "2026-03-16T11:00:00.000Z",
        }),
      ],
      projects: [makeProject()],
      threads: [],
    });

    expect(entries).toEqual(["three", "two", "one"]);
  });

  it("falls back to same-project entries newest first when the thread is new", () => {
    const entries = resolveComposerPromptHistoryEntries({
      currentProjectId: ProjectId.makeUnsafe("project-1"),
      currentThreadMessages: [],
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-older"),
          messages: [
            makeMessage({
              id: "message-1" as ChatMessage["id"],
              text: "one",
              createdAt: "2026-03-16T09:00:00.000Z",
            }),
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          messages: [
            makeMessage({
              id: "message-2" as ChatMessage["id"],
              text: "two",
              createdAt: "2026-03-16T10:00:00.000Z",
            }),
            makeMessage({
              id: "message-3" as ChatMessage["id"],
              text: "three",
              createdAt: "2026-03-16T11:00:00.000Z",
            }),
          ],
        }),
      ],
    });

    expect(entries).toEqual(["three", "two", "one"]);
  });
});

describe("navigateComposerPromptHistory", () => {
  it("walks backward through history and restores the saved draft on the way back down", () => {
    const entries = ["three", "two", "one"];

    const firstUp = navigateComposerPromptHistory({
      currentPrompt: "draft",
      direction: "up",
      entries,
      navigationState: null,
    });
    expect(firstUp).toEqual({
      handled: true,
      nextNavigationState: {
        draftPrompt: "draft",
        historyIndex: 0,
      },
      nextPrompt: "three",
    });

    const secondUp = navigateComposerPromptHistory({
      currentPrompt: firstUp.nextPrompt,
      direction: "up",
      entries,
      navigationState: firstUp.nextNavigationState,
    });
    expect(secondUp.nextPrompt).toBe("two");
    expect(secondUp.nextNavigationState?.historyIndex).toBe(1);

    const firstDown = navigateComposerPromptHistory({
      currentPrompt: secondUp.nextPrompt,
      direction: "down",
      entries,
      navigationState: secondUp.nextNavigationState,
    });
    expect(firstDown.nextPrompt).toBe("three");
    expect(firstDown.nextNavigationState?.historyIndex).toBe(0);

    const secondDown = navigateComposerPromptHistory({
      currentPrompt: firstDown.nextPrompt,
      direction: "down",
      entries,
      navigationState: firstDown.nextNavigationState,
    });
    expect(secondDown).toEqual({
      handled: true,
      nextNavigationState: null,
      nextPrompt: "draft",
    });
  });

  it("does not handle navigation when no history exists", () => {
    expect(
      navigateComposerPromptHistory({
        currentPrompt: "",
        direction: "up",
        entries: [],
        navigationState: null,
      }),
    ).toEqual({
      handled: false,
      nextNavigationState: null,
      nextPrompt: "",
    });
  });

  it("does nothing when already at the oldest history entry and pressing up again", () => {
    expect(
      navigateComposerPromptHistory({
        currentPrompt: "one",
        direction: "up",
        entries: ["three", "two", "one"],
        navigationState: {
          draftPrompt: "draft",
          historyIndex: 2,
        },
      }),
    ).toEqual({
      handled: false,
      nextNavigationState: {
        draftPrompt: "draft",
        historyIndex: 2,
      },
      nextPrompt: "one",
    });
  });
});
