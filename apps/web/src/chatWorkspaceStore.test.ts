import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CHAT_WORKSPACE_SPLIT_RATIO,
  MAX_CHAT_WORKSPACE_SPLIT_RATIO,
  MIN_CHAT_WORKSPACE_SPLIT_RATIO,
  chatWorkspaceTargetKey,
  parsePersistedChatWorkspaceState,
  useChatWorkspaceStore,
} from "./chatWorkspaceStore";

const THREAD_A = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-a"));
const THREAD_B = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-b"));
const THREAD_C = scopeThreadRef(EnvironmentId.make("environment-2"), ThreadId.make("thread-a"));

describe("chatWorkspaceStore", () => {
  beforeEach(() => useChatWorkspaceStore.getState().reset());

  it("normalizes persisted panes, removes duplicates, and ignores malformed entries", () => {
    const parsed = parsePersistedChatWorkspaceState({
      panes: [
        { id: "stale-id", target: { kind: "server", threadRef: THREAD_A } },
        { id: "duplicate", target: { kind: "server", threadRef: THREAD_A } },
        { id: "draft", target: { kind: "draft", draftId: "draft-1" } },
        {
          id: "invalid",
          target: { kind: "server", threadRef: { threadId: "missing-environment" } },
        },
      ],
      activePaneId: "stale-id",
      splitRatio: 0.9,
    });

    expect(parsed.panes).toEqual([
      {
        id: chatWorkspaceTargetKey({ kind: "server", threadRef: THREAD_A }),
        target: { kind: "server", threadRef: THREAD_A },
      },
      { id: "draft:draft-1", target: { kind: "draft", draftId: "draft-1" } },
    ]);
    expect(parsed.activePaneId).toBe(parsed.panes[0]?.id);
    expect(parsed.splitRatio).toBe(MAX_CHAT_WORKSPACE_SPLIT_RATIO);
    expect(parsePersistedChatWorkspaceState({ panes: { invalid: true } }).panes).toEqual([]);
    expect(parsePersistedChatWorkspaceState({}).splitRatio).toBe(
      DEFAULT_CHAT_WORKSPACE_SPLIT_RATIO,
    );
  });

  it("adds panes, focuses an existing target, and closes to a neighboring pane", () => {
    const store = useChatWorkspaceStore.getState();
    const firstPaneId = store.addPane({ kind: "server", threadRef: THREAD_A });
    const secondPaneId = store.addPane({ kind: "server", threadRef: THREAD_B });

    expect(useChatWorkspaceStore.getState().panes.map((pane) => pane.id)).toEqual([
      firstPaneId,
      secondPaneId,
    ]);
    expect(useChatWorkspaceStore.getState().activePaneId).toBe(secondPaneId);

    expect(store.addPane({ kind: "server", threadRef: THREAD_A })).toBe(firstPaneId);
    expect(useChatWorkspaceStore.getState().activePaneId).toBe(firstPaneId);

    useChatWorkspaceStore.getState().closePane(firstPaneId);
    expect(useChatWorkspaceStore.getState().panes.map((pane) => pane.id)).toEqual([secondPaneId]);
    expect(useChatWorkspaceStore.getState().activePaneId).toBe(secondPaneId);
  });

  it("keeps secondary panes while replacing the active route target", () => {
    const store = useChatWorkspaceStore.getState();
    store.addPane({ kind: "server", threadRef: THREAD_A });
    const secondPaneId = store.addPane({ kind: "server", threadRef: THREAD_B });

    const replacementPaneId = store.replaceActivePane({ kind: "server", threadRef: THREAD_C });
    const state = useChatWorkspaceStore.getState();

    expect(replacementPaneId).toBe(
      chatWorkspaceTargetKey({ kind: "server", threadRef: THREAD_C }),
    );
    expect(state.panes.map((pane) => pane.id)).toEqual([
      chatWorkspaceTargetKey({ kind: "server", threadRef: THREAD_A }),
      replacementPaneId,
    ]);
    expect(state.activePaneId).toBe(replacementPaneId);
  });

  it("clamps the persisted split ratio to usable pane bounds", () => {
    const store = useChatWorkspaceStore.getState();

    store.setSplitRatio(0.01);
    expect(useChatWorkspaceStore.getState().splitRatio).toBe(MIN_CHAT_WORKSPACE_SPLIT_RATIO);

    store.setSplitRatio(0.6);
    expect(useChatWorkspaceStore.getState().splitRatio).toBe(0.6);
  });
});
