import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2HandoffBundleV1,
  type ProjectId,
  type ThreadHandoffId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

const nextCommandId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(yield* crypto.randomUUIDv4);
});

/**
 * Asks the environment that owns a thread to stage a hop. Nothing the user can
 * see changes: the thread is not locked until `departThread`, so a preflight
 * the user then declines leaves only staged bytes behind.
 */
export const prepareThreadHandoff = Effect.fn("EnvironmentCommands.prepareThreadHandoff")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly peerEnvironmentId: EnvironmentId;
    readonly peerBranchTip: string | null;
    readonly fullHistory: boolean;
    readonly previousHandoffId: ThreadHandoffId | null;
    readonly hopCount: number;
  }) {
    return yield* request(ORCHESTRATION_V2_WS_METHODS.prepareThreadHandoff, {
      threadId: input.threadId,
      peerEnvironmentId: input.peerEnvironmentId,
      peerBranchTip: input.peerBranchTip,
      fullHistory: input.fullHistory,
      previousHandoffId: input.previousHandoffId,
      hopCount: input.hopCount,
    });
  },
);

/** Applies a staged bundle on the environment that is taking the thread. */
export const receiveThreadHandoff = Effect.fn("EnvironmentCommands.receiveThreadHandoff")(
  function* (input: {
    readonly bundle: OrchestrationV2HandoffBundleV1;
    readonly projectId: ProjectId | null;
    readonly cloneWorkspaceRoot: string | null;
    readonly returningThreadId: ThreadId | null;
  }) {
    return yield* request(ORCHESTRATION_V2_WS_METHODS.receiveThreadHandoff, {
      bundle: input.bundle,
      projectId: input.projectId,
      cloneWorkspaceRoot: input.cloneWorkspaceRoot,
      returningThreadId: input.returningThreadId,
    });
  },
);

/**
 * Locks the giving side. Dispatched before any bundle is applied anywhere, so
 * the two sides can never both be live; a transfer that dies after this leaves
 * a locked thread that `abortThreadHandoff` releases.
 */
export const departThread = Effect.fn("EnvironmentCommands.departThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly handoffId: ThreadHandoffId;
  readonly peerEnvironmentId: EnvironmentId;
  readonly peerLabel: string | null;
  readonly previousHandoffId: ThreadHandoffId | null;
  readonly hopCount: number;
}) {
  return yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    type: "thread.handoff.depart",
    commandId: yield* nextCommandId,
    threadId: input.threadId,
    handoffId: input.handoffId,
    peerEnvironmentId: input.peerEnvironmentId,
    peerLabel: input.peerLabel,
    previousHandoffId: input.previousHandoffId,
    hopCount: input.hopCount,
  });
});

/** Records the peer's thread id on the giving side once the bundle has landed. */
export const completeThreadHandoff = Effect.fn("EnvironmentCommands.completeThreadHandoff")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly handoffId: ThreadHandoffId;
    readonly peerThreadId: ThreadId;
  }) {
    return yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "thread.handoff.complete",
      commandId: yield* nextCommandId,
      threadId: input.threadId,
      handoffId: input.handoffId,
      peerThreadId: input.peerThreadId,
    });
  },
);

/** Releases a departed thread whose transfer never landed. */
export const abortThreadHandoff = Effect.fn("EnvironmentCommands.abortThreadHandoff")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly handoffId: ThreadHandoffId;
    readonly reason: string | null;
  }) {
    return yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "thread.handoff.abort",
      commandId: yield* nextCommandId,
      threadId: input.threadId,
      handoffId: input.handoffId,
      reason: input.reason,
    });
  },
);
