import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasServerAcknowledgedPendingTurn,
  isPendingTurnActive,
  usePendingTurnStore,
} from "./pendingTurnStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
  ThreadId.make("thread-1"),
);

describe("pendingTurnStore", () => {
  beforeEach(() => {
    usePendingTurnStore.setState({
      pendingByThreadKey: {},
      optimisticMessagesByThreadKey: {},
    });
  });

  it("keeps pending feedback available across component remounts", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);

    const pendingTurn = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0];
    expect(isPendingTurnActive(pendingTurn, null)).toBe(true);
  });

  it("does not treat pre-turn provider session binding as acknowledgement", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    const pendingTurn = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0]!;

    expect(
      hasServerAcknowledgedPendingTurn({
        pendingTurn,
        phase: "ready",
        latestTurn: null,
        session: {
          provider: ProviderDriverKind.make("copilot"),
          status: "ready",
          createdAt: pendingTurn.startedAt,
          updatedAt: "2026-01-01T00:00:01.000Z",
          orchestrationStatus: "idle",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a pending send once a turn is projected", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    const pendingTurn = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0]!;

    expect(
      hasServerAcknowledgedPendingTurn({
        pendingTurn,
        phase: "ready",
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-01-01T00:00:01.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          provider: ProviderDriverKind.make("copilot"),
          status: "ready",
          createdAt: pendingTurn.startedAt,
          updatedAt: "2026-01-01T00:00:01.000Z",
          orchestrationStatus: "idle",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("keeps optimistic messages available across component remounts", () => {
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Ship it",
      createdAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
    });

    expect(Object.values(usePendingTurnStore.getState().optimisticMessagesByThreadKey)).toEqual([
      [
        expect.objectContaining({
          id: "message-1",
          text: "Ship it",
        }),
      ],
    ]);
  });

  it("clears all shared thread state when the server removes a thread", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-1"),
      role: "user",
      text: "Ship it",
      createdAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
    });

    usePendingTurnStore.getState().clearThreadState(threadRef);

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
    expect(usePendingTurnStore.getState().optimisticMessagesByThreadKey).toEqual({});
  });

  it("owns and revokes optimistic attachment previews until thread cleanup", () => {
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    usePendingTurnStore.getState().addOptimisticMessage(threadRef, {
      id: MessageId.make("message-image"),
      role: "user",
      text: "",
      attachments: [
        {
          type: "image",
          id: "image-1",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 10,
          previewUrl: "blob:optimistic-image",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
    });

    usePendingTurnStore.getState().clearThreadState(threadRef);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:optimistic-image");
  });

  it("clears pending feedback explicitly after acknowledgement or failure", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    usePendingTurnStore.getState().clearPendingTurn(threadRef);

    expect(usePendingTurnStore.getState().pendingByThreadKey).toEqual({});
  });

  it("replaces an acknowledged snapshot when a later send starts", () => {
    usePendingTurnStore.getState().beginPendingTurn(threadRef, undefined);
    const first = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0]!;

    usePendingTurnStore.getState().beginPendingTurn(threadRef, {
      id: threadRef.threadId,
      environmentId: threadRef.environmentId,
      codexThreadId: null,
      projectId: ProjectId.make("project-1"),
      parentThreadId: null,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-5" },
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      interactionMode: "default",
      session: {
        provider: ProviderDriverKind.make("copilot"),
        status: "ready",
        createdAt: first.startedAt,
        updatedAt: "2026-01-01T00:00:01.000Z",
        orchestrationStatus: "idle",
      },
      messages: [],
      proposedPlans: [],
      queuedTurns: [],
      error: null,
      createdAt: first.startedAt,
      archivedAt: null,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: first.startedAt,
        startedAt: first.startedAt,
        completedAt: "2026-01-01T00:00:01.000Z",
        assistantMessageId: null,
      },
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    const second = Object.values(usePendingTurnStore.getState().pendingByThreadKey)[0]!;
    expect(second).not.toBe(first);
  });
});
