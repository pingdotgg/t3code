import { describe, expect, it } from "vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";

import type { EnvironmentState } from "./store";
import {
  getThreadCoreFromEnvironmentState,
  getThreadFromEnvironmentState,
  selectThreadMessageIds,
} from "./threadDerivation";
import type { ThreadShell } from "./types";

const THREAD_ID = ThreadId.make("thread-1");

function buildShell(): ThreadShell {
  return {
    id: THREAD_ID,
    environmentId: "env-1" as ThreadShell["environmentId"],
    projectId: "project-1" as ThreadShell["projectId"],
    codexThreadId: null,
    parentThreadId: null,
    title: "Test thread",
    branch: null,
    worktreePath: null,
    modelSelection: {
      instanceId: "codex" as ThreadShell["modelSelection"]["instanceId"],
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    pendingRuntimeMode: null,
    interactionMode: "default",
    error: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function buildState(messageText: string): EnvironmentState {
  const shell = buildShell();
  const messageId = MessageId.make("message-1");
  return {
    threadShellById: { [THREAD_ID]: shell },
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: { [THREAD_ID]: [messageId] },
    messageByThreadId: {
      [THREAD_ID]: {
        [messageId]: {
          id: messageId,
          role: "assistant",
          text: messageText,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
    activityIdsByThreadId: {},
    activityByThreadId: {},
    activityContextByThreadId: {},
    hasMoreActivitiesByThreadId: {},
    hasMoreCurrentTurnActivitiesByThreadId: {},
    insightActivitiesByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    queuedTurnsByThreadId: {},
  } as EnvironmentState;
}

describe("getThreadCoreFromEnvironmentState", () => {
  it("rebuilds the core thread when shell-owned fields change", () => {
    const state = buildState("Hello");
    const firstThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);
    const shell = state.threadShellById[THREAD_ID]!;
    state.threadShellById = {
      ...state.threadShellById,
      [THREAD_ID]: {
        ...shell,
        title: "Renamed thread",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    };

    const secondThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);

    expect(firstThread).toBeDefined();
    expect(secondThread).not.toBe(firstThread);
    expect(secondThread?.title).toBe("Renamed thread");
  });

  it("rebuilds the core thread when the shell error changes", () => {
    const state = buildState("Hello");
    const firstThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);
    const shell = state.threadShellById[THREAD_ID]!;
    state.threadShellById = {
      ...state.threadShellById,
      [THREAD_ID]: {
        ...shell,
        error: "Provider disconnected",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    };

    const secondThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);

    expect(firstThread).toBeDefined();
    expect(secondThread).not.toBe(firstThread);
    expect(secondThread?.error).toBe("Provider disconnected");
  });

  it("returns a stable thread reference when the shell is replaced on stream", () => {
    const state = buildState("Hello");
    const firstThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);
    const shell = state.threadShellById[THREAD_ID]!;
    state.threadShellById = {
      ...state.threadShellById,
      [THREAD_ID]: {
        ...shell,
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    };
    const messageId = state.messageIdsByThreadId[THREAD_ID]![0]!;
    state.messageByThreadId[THREAD_ID]![messageId] = {
      ...state.messageByThreadId[THREAD_ID]![messageId]!,
      text: "Hello world",
    };

    const secondThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);

    expect(firstThread).toBeDefined();
    expect(secondThread).toBe(firstThread);
  });

  it("returns a stable thread reference when only message text changes", () => {
    const state = buildState("Hello");
    const firstThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);
    const messageId = state.messageIdsByThreadId[THREAD_ID]![0]!;
    state.messageByThreadId[THREAD_ID]![messageId] = {
      ...state.messageByThreadId[THREAD_ID]![messageId]!,
      text: "Hello world",
    };

    const secondThread = getThreadCoreFromEnvironmentState(state, THREAD_ID);

    expect(firstThread).toBeDefined();
    expect(secondThread).toBe(firstThread);
    expect(firstThread?.messages).toEqual([]);
  });

  it("returns live messages from getThreadFromEnvironmentState", () => {
    const state = buildState("Hello world");
    const thread = getThreadFromEnvironmentState(state, THREAD_ID);

    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]?.text).toBe("Hello world");
  });
});

describe("selectThreadMessageIds", () => {
  it("returns the same id list when only message text changes", () => {
    const state = buildState("Hello");
    const firstIds = selectThreadMessageIds(state, THREAD_ID);
    const messageId = state.messageIdsByThreadId[THREAD_ID]![0]!;
    state.messageByThreadId[THREAD_ID]![messageId] = {
      ...state.messageByThreadId[THREAD_ID]![messageId]!,
      text: "Hello world",
    };

    expect(selectThreadMessageIds(state, THREAD_ID)).toBe(firstIds);
  });
});
