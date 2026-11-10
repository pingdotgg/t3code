import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import {
  canForkProjectedAssistantItem,
  deriveThreadQueueWorkflowState,
  resolveLatestMergeBackRun,
  threadSupportsProviderHandoff,
} from "./threadWorkflows.ts";

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly steerAttachments?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}) =>
  ({
    turns: {
      supportsQueuedMessages: input?.queued ?? false,
      supportsActiveSteering: input?.steer ?? false,
      supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
      activeSteeringAcceptsAttachments: input?.steerAttachments ?? true,
    },
    threads: {
      canForkThread: input?.nativeFork ?? false,
      canForkFromTurn: input?.nativeFork ?? false,
    },
    identity: { nativeThreadIds: input?.nativeFork ? "strong" : "none" },
    context: { supportsFullThreadHandoff: input?.portableFork ?? false },
  }) as never;

describe("thread workflows", () => {
  it("allows a completed thread to switch providers after its session detaches", () => {
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "provider-thread",
        modelSelection: { instanceId: "cursor", model: "grok-4.7" },
      },
      runs: [{ id: "run", status: "completed" }],
      providerSessions: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerInstanceId: "cursor",
          providerSessionId: "detached-session",
          nativeThreadRef: { driver: "cursor", nativeId: "agent-123", strength: "strong" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadSupportsProviderHandoff(projection)).toBe(true);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [{ ...projection.runs[0]!, status: "running" }],
      }),
    ).toBe(false);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
      }),
    ).toBe(false);
  });

  it("sorts queued messages and gates promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        {
          id: "message-first",
          text: "First",
          attachments: [
            {
              type: "image",
              id: "attachment-first",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
        { id: "message-later", text: "Later" },
      ],
      providerTurns: [
        {
          id: "provider-turn-active",
          runAttemptId: "attempt-active",
          status: "running",
        },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["first", "First"],
      ["later", "Later"],
    ]);
    expect(state.queuedRuns.map(({ attachments }) => attachments.map(({ id }) => id))).toEqual([
      ["attachment-first"],
      [],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canPromoteToSteer).toBe(true);
    expect(state.canSendNow).toBe(false);
  });

  it.each(["completed", "interrupted", "cancelled", "failed"])(
    "allows sending a held message after a %s turn without a live session",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [
          { id: "previous", status, ordinal: 1 },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2, queueHeld: true },
        ],
        messages: [{ id: "message", text: "Send this" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);

      expect(state.canSendNow).toBe(true);
      expect(state.canPromoteToSteer).toBe(false);
      expect(state.isHeld).toBe(true);
    },
  );

  it.each(["preparing", "starting", "running", "waiting"])(
    "does not offer send now while a turn is %s",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "active", status, ordinal: 1 }],
        messages: [],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);

      expect(state.canSendNow).toBe(false);
    },
  );

  it("offers to skip a running compaction even when the provider cannot steer", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        { id: "compact", status: "running", userMessageId: "message-compact", ordinal: 1 },
        { id: "queued", status: "queued", userMessageId: "message-queued", ordinal: 2 },
      ],
      messages: [
        { id: "message-compact", role: "user", text: "/compact", attachments: [] },
        { id: "message-queued", role: "user", text: "Next", attachments: [] },
      ],
      providerThreads: [],
      providerTurns: [],
      providerSessions: [],
    } as never);

    expect(state.canPromoteToSteer).toBe(true);
    expect(state.promoteSkipsCompaction).toBe(true);
  });

  it("keeps held messages visible and clears the hold when they leave the queue", () => {
    for (const status of ["queued", "cancelled", "starting"] as const) {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "held", status, userMessageId: "message", ordinal: 1, queueHeld: true }],
        messages: [{ id: "message", text: "Saved message" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);
      expect(state.isHeld).toBe(status === "queued");
      expect(state.queuedRuns.map(({ text }) => text)).toEqual(
        status === "queued" ? ["Saved message"] : [],
      );
    }
  });

  it("hides automatic completion delivery from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        {
          id: "provider-wake",
          status: "queued",
          userMessageId: "provider-wake",
          ordinal: 4,
          queuePosition: 3,
        },
        {
          id: "automatic",
          status: "queued",
          userMessageId: "message-automatic",
          ordinal: 2,
          queuePosition: 1,
        },
        {
          id: "visible",
          status: "queued",
          userMessageId: "message-visible",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        {
          id: "provider-wake",
          text: "Model-facing text",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor updated",
          },
        },
        {
          id: "message-automatic",
          text: "A delegated task reached a terminal state.",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message-visible", text: "Visible queued message" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["visible", "Visible queued message"],
    ]);
  });

  it("removes only the promoted head from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "promoted",
          status: "starting",
          userMessageId: "message-promoted",
          providerThreadId: "provider-thread",
          ordinal: 2,
          queuePosition: null,
        },
        {
          id: "still-queued",
          status: "queued",
          userMessageId: "message-still-queued",
          providerThreadId: "provider-thread",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        { id: "message-promoted", text: "Run now" },
        { id: "message-still-queued", text: "Wait longer" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.activeRun?.id).toBe("promoted");
    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["still-queued", "Wait longer"],
    ]);
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "does not promote queued work into a %s run",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status,
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            ordinal: 1,
          },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued" }],
        providerTurns: [
          {
            id: "provider-turn-active",
            runAttemptId: "attempt-active",
            status: status === "waiting" ? "completed" : "starting",
          },
        ],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "thread",
            providerSessionId: "provider-session",
          },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      } as never);

      expect(state.canPromoteToSteer).toBe(false);
    },
  );

  const selection = { instanceId: "codex", model: "gpt-5.4" };
  const image = { type: "image", id: "image", name: "a.png", mimeType: "image/png", sizeBytes: 8 };
  const cannotJoin = "Some queued messages can't join the current turn.";
  it.each([
    { name: "a steerable turn", asOne: null, each: null },
    {
      name: "an agent that restarts to steer",
      provider: { restartSteer: true },
      asOne: null,
      each: "This agent restarts its turn for every message. Send them as one instead.",
    },
    {
      name: "queued messages on a different model from the active turn without restart steering",
      provider: { restartSupported: false },
      activeModel: "another-model",
      asOne: cannotJoin,
      each: cannotJoin,
    },
    {
      name: "attachments without restart steering",
      provider: { restartSupported: false, steerAttachments: false },
      second: { attachments: [image] },
      asOne: cannotJoin,
      each: cannotJoin,
    },
    {
      name: "compaction without restart steering",
      provider: { restartSupported: false, steerAttachments: false },
      activeMessage: { text: "/compact" },
      second: { attachments: [image] },
      asOne: null,
      each: "Send them as one to skip the compaction.",
    },
    {
      name: "a notification between user messages",
      notificationPosition: 3,
      asOne: "A notification is waiting between these messages.",
      each: null,
    },
    {
      name: "a notification before user messages",
      notificationPosition: 1,
      asOne: null,
      each: null,
    },
    {
      name: "a notification after user messages",
      notificationPosition: 5,
      asOne: null,
      each: null,
    },
    { name: "a stopped thread", activeStatus: "completed", asOne: null, each: null },
    {
      name: "a turn not yet steerable",
      activeStatus: "starting",
      asOne: "The current turn can't take messages right now.",
      each: "The current turn can't take messages right now.",
    },
    {
      name: "a guest's message",
      second: { context: { version: 1, records: [], guest: { name: "Sam", text: "Hi" } } },
      asOne: "A guest's message can't be combined with others.",
      each: null,
    },
    {
      name: "an agent's message",
      second: { createdBy: "agent", senderThreadId: "thread:lead" },
      asOne: "Messages from agents and automations are sent on their own.",
      each: null,
    },
    {
      name: "a command",
      second: { text: "/compact" },
      asOne: "Commands are sent on their own.",
      each: cannotJoin,
    },
    {
      name: "a fresh-session message",
      secondRun: { freshContext: true },
      asOne: "A message that starts a fresh session is sent on its own.",
      each: cannotJoin,
    },
    {
      name: "a plan implementation",
      secondRun: { sourcePlanRef: { threadId: "thread", planId: "plan" } },
      asOne: "Plan and continuation messages are sent on their own.",
      each: null,
    },
    {
      name: "another model",
      secondRun: { modelSelection: { ...selection, model: "gpt-5.5" } },
      asOne: "Queued messages use different models.",
      each: cannotJoin,
    },
    {
      name: "attachments the turn cannot take",
      provider: { steerAttachments: false },
      second: { attachments: [image] },
      asOne: null,
      each: cannotJoin,
    },
  ] as const)(
    "offers sending the whole queue for $name",
    (row: {
      readonly provider?: {
        readonly restartSteer?: boolean;
        readonly restartSupported?: boolean;
        readonly steerAttachments?: boolean;
      };
      readonly activeStatus?: string;
      readonly activeModel?: string;
      readonly activeMessage?: Record<string, unknown>;
      readonly notificationPosition?: number;
      readonly second?: Record<string, unknown>;
      readonly secondRun?: Record<string, unknown>;
      readonly asOne: string | null;
      readonly each: string | null;
    }) => {
      const message = (id: string, fields?: Record<string, unknown>) => ({
        id,
        role: "user",
        text: id,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        ...fields,
      });
      const queued = (id: string, ordinal: number, fields?: Record<string, unknown>) => ({
        id,
        status: "queued",
        userMessageId: `message-${id}`,
        modelSelection: selection,
        ordinal,
        ...fields,
      });
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status: row.activeStatus ?? "running",
            userMessageId: "message-active",
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            modelSelection: { ...selection, model: row.activeModel ?? selection.model },
            ordinal: 1,
          },
          queued("first", 2),
          queued("second", 4, row.secondRun),
          ...(row.notificationPosition === undefined
            ? []
            : [queued("notification", 5, { queuePosition: row.notificationPosition })]),
        ],
        messages: [
          message("message-active", row.activeMessage),
          message("message-first"),
          message("message-second", row.second),
          ...(row.notificationPosition === undefined
            ? []
            : [
                message("message-notification", {
                  notification: {
                    source: { kind: "monitor" },
                    outcome: "updated",
                    summary: "PR update",
                  },
                }),
              ]),
        ],
        providerTurns: [
          { id: "provider-turn-active", runAttemptId: "attempt-active", status: "running" },
        ],
        providerThreads: [
          { id: "provider-thread", appThreadId: "thread", providerSessionId: "provider-session" },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({
              queued: true,
              steer: row.provider?.restartSteer !== true,
              restartSteer: row.provider?.restartSupported ?? true,
              ...(row.provider?.steerAttachments === undefined
                ? {}
                : { steerAttachments: row.provider.steerAttachments }),
            }),
          },
        ],
      } as never);

      expect([state.sendAsOneBlockedReason, state.sendEachBlockedReason]).toEqual([
        row.asOne,
        row.each,
      ]);
    },
  );

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });

  it("merges the newest provider-finished run while checkpoint capture is pending", () => {
    const projection = {
      runs: [
        { id: "newest-queued", status: "queued", ordinal: 3 },
        { id: "older-completed", status: "completed", ordinal: 1 },
        { id: "newest-finished", status: "waiting", ordinal: 2 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it.each(["preparing", "starting", "running"] as const)(
    "does not merge older history while a newer run is %s",
    (status) => {
      const projection = {
        runs: [
          { id: "older-completed", status: "completed", ordinal: 1 },
          { id: "newer-active", status, ordinal: 2 },
        ],
      } as never;

      expect(resolveLatestMergeBackRun(projection)).toBeNull();
    },
  );
});
