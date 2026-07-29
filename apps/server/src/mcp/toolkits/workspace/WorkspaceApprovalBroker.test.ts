import { beforeEach, expect, it } from "@effect/vitest";
import { ThreadId, type ProviderApprovalDecision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  __testing,
  hasWorkspaceApprovalChannel,
  openWorkspaceApproval,
  registerWorkspaceApprovalChannel,
  resolveWorkspaceApproval,
  unregisterWorkspaceApprovalChannel,
  type WorkspaceApprovalChannel,
} from "./WorkspaceApprovalBroker.ts";

const threadId = ThreadId.make("thread-broker-1");

interface EmittedEvent {
  readonly kind: "opened" | "resolved";
  readonly requestId: string;
  readonly requestType: string;
  readonly decision?: ProviderApprovalDecision;
}

const makeChannel = (): { channel: WorkspaceApprovalChannel; events: Array<EmittedEvent> } => {
  const events: Array<EmittedEvent> = [];
  return {
    events,
    channel: {
      emitOpened: (input) =>
        Effect.sync(() => {
          events.push({
            kind: "opened",
            requestId: input.requestId,
            requestType: input.requestType,
          });
        }),
      emitResolved: (input) =>
        Effect.sync(() => {
          events.push({
            kind: "resolved",
            requestId: input.requestId,
            requestType: input.requestType,
            decision: input.decision,
          });
        }),
    },
  };
};

beforeEach(() => {
  __testing.reset();
});

it.effect("carries a question to the channel and the answer back to the waiter", () =>
  Effect.gen(function* () {
    const { channel, events } = makeChannel();
    registerWorkspaceApprovalChannel(threadId, channel);

    const ticket = yield* openWorkspaceApproval({
      threadId,
      requestType: "exec_command_approval",
      detail: "$ pnpm test",
    });
    expect(ticket).not.toBeUndefined();
    expect(ticket).not.toBe("auto-accepted");
    if (ticket === undefined || ticket === "auto-accepted") return;

    expect(events).toEqual([
      { kind: "opened", requestId: ticket.requestId, requestType: "exec_command_approval" },
    ]);

    const handled = yield* resolveWorkspaceApproval(threadId, ticket.requestId, "accept");
    expect(handled).toBe(true);
    expect(yield* ticket.decision).toBe("accept");
    expect(events[1]).toEqual({
      kind: "resolved",
      requestId: ticket.requestId,
      requestType: "exec_command_approval",
      decision: "accept",
    });
  }),
);

it.effect("refuses to open approvals for a thread with no channel", () =>
  Effect.gen(function* () {
    const ticket = yield* openWorkspaceApproval({
      threadId,
      requestType: "file_change_approval",
      detail: "write x",
    });
    expect(ticket).toBeUndefined();
    expect(hasWorkspaceApprovalChannel(threadId)).toBe(false);
  }),
);

it.effect("acceptForSession short-circuits later requests of the same type only", () =>
  Effect.gen(function* () {
    const { channel } = makeChannel();
    registerWorkspaceApprovalChannel(threadId, channel);

    const first = yield* openWorkspaceApproval({
      threadId,
      requestType: "exec_command_approval",
      detail: "$ ls",
    });
    if (first === undefined || first === "auto-accepted") throw new Error("expected ticket");
    yield* resolveWorkspaceApproval(threadId, first.requestId, "acceptForSession");
    expect(yield* first.decision).toBe("acceptForSession");

    // Same type: auto-accepted without a card.
    const second = yield* openWorkspaceApproval({
      threadId,
      requestType: "exec_command_approval",
      detail: "$ pwd",
    });
    expect(second).toBe("auto-accepted");

    // Different type: still asks.
    const third = yield* openWorkspaceApproval({
      threadId,
      requestType: "file_change_approval",
      detail: "write y",
    });
    expect(third).not.toBe("auto-accepted");
    expect(third).not.toBeUndefined();
  }),
);

it.effect("unregister cancels in-flight approvals and forgets session accepts", () =>
  Effect.gen(function* () {
    const { channel } = makeChannel();
    registerWorkspaceApprovalChannel(threadId, channel);

    const pendingTicket = yield* openWorkspaceApproval({
      threadId,
      requestType: "apply_patch_approval",
      detail: "patch",
    });
    if (pendingTicket === undefined || pendingTicket === "auto-accepted") {
      throw new Error("expected ticket");
    }

    const accepted = yield* openWorkspaceApproval({
      threadId,
      requestType: "exec_command_approval",
      detail: "$ ls",
    });
    if (accepted === undefined || accepted === "auto-accepted") throw new Error("expected ticket");
    yield* resolveWorkspaceApproval(threadId, accepted.requestId, "acceptForSession");

    yield* unregisterWorkspaceApprovalChannel(threadId);

    // The parked waiter is released as cancel rather than hanging forever.
    expect(yield* pendingTicket.decision).toBe("cancel");
    expect(__testing.pendingCount()).toBe(0);

    // A new session starts from scratch: no channel, no remembered accepts.
    registerWorkspaceApprovalChannel(threadId, makeChannel().channel);
    const afterRestart = yield* openWorkspaceApproval({
      threadId,
      requestType: "exec_command_approval",
      detail: "$ ls",
    });
    expect(afterRestart).not.toBe("auto-accepted");
  }),
);

it.effect("resolving an unknown or foreign request id reports unhandled", () =>
  Effect.gen(function* () {
    const { channel } = makeChannel();
    registerWorkspaceApprovalChannel(threadId, channel);
    const ticket = yield* openWorkspaceApproval({
      threadId,
      requestType: "file_change_approval",
      detail: "write z",
    });
    if (ticket === undefined || ticket === "auto-accepted") throw new Error("expected ticket");

    expect(yield* resolveWorkspaceApproval(threadId, "nope", "accept")).toBe(false);
    // A different thread cannot answer this thread's approvals.
    expect(
      yield* resolveWorkspaceApproval(ThreadId.make("thread-other"), ticket.requestId, "accept"),
    ).toBe(false);
    expect(yield* resolveWorkspaceApproval(threadId, ticket.requestId, "decline")).toBe(true);
    expect(yield* ticket.decision).toBe("decline");
  }),
);
