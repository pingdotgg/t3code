import type { EnvironmentId, ProjectId, ThreadHandoffId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { createAtomCommandScheduler, createRuntimeCommand, runInEnvironment } from "./runtime.ts";
import { runThreadHandoffTransfer, type ThreadHandoffProgress } from "./threadHandoffTransfer.ts";

export interface MoveThreadInput {
  readonly threadId: ThreadId;
  readonly originEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string | null;
  readonly targetProjectId: ProjectId | null;
  readonly cloneWorkspaceRoot: string | null;
  readonly returningThreadId: ThreadId | null;
  readonly targetBranchTip: string | null;
  readonly previousHandoffId: ThreadHandoffId | null;
  readonly hopCount: number;
  readonly onProgress?: (progress: ThreadHandoffProgress) => void;
}

/**
 * The live connection for one environment. A hop needs both in hand before it
 * starts: discovering halfway through that the destination was never reachable
 * would mean locking a thread for a transfer that could not have worked.
 */
const connectionFor = Effect.fn("clientRuntime.state.handoffConnection")(function* (
  environmentId: EnvironmentId,
) {
  const prepared = yield* runInEnvironment(
    environmentId,
    EnvironmentSupervisor.pipe(
      Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.prepared)),
    ),
  );
  if (Option.isNone(prepared)) {
    return yield* Effect.fail(new ThreadHandoffEnvironmentUnreachableError({ environmentId }));
  }
  return prepared.value satisfies PreparedConnection;
});

export class ThreadHandoffEnvironmentUnreachableError extends Schema.TaggedErrorClass<ThreadHandoffEnvironmentUnreachableError>()(
  "ThreadHandoffEnvironmentUnreachableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not connected, so a thread cannot be moved to or from it.`;
  }
}

/**
 * A handoff spans two environments, so it is a runtime command rather than an
 * environment one: neither side owns it, and both connections have to be in
 * hand before the first byte moves.
 */
export function createThreadHandoffAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | HttpClient.HttpClient | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    move: createRuntimeCommand(runtime, {
      label: "environment-data:commands:thread:handoff:move",
      scheduler,
      // One hop at a time per thread. Two concurrent hops would each try to
      // lock the same thread, and the second would fail after the first had
      // already moved bytes.
      concurrency: {
        mode: "serial" as const,
        key: (input: MoveThreadInput) => input.threadId,
      },
      execute: (input: MoveThreadInput) =>
        Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const originConnection = yield* connectionFor(input.originEnvironmentId);
          const targetConnection = yield* connectionFor(input.targetEnvironmentId);
          return yield* runThreadHandoffTransfer({
            threadId: input.threadId,
            originEnvironmentId: input.originEnvironmentId,
            targetEnvironmentId: input.targetEnvironmentId,
            targetLabel: input.targetLabel,
            targetProjectId: input.targetProjectId,
            cloneWorkspaceRoot: input.cloneWorkspaceRoot,
            returningThreadId: input.returningThreadId,
            targetBranchTip: input.targetBranchTip,
            previousHandoffId: input.previousHandoffId,
            hopCount: input.hopCount,
            originConnection,
            targetConnection,
            signer: signer as Option.Option<ManagedRelayDpopSigner["Service"]>,
            ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
          });
        }),
    }),
  };
}
