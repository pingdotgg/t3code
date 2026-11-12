import { EnvironmentId, type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import { EventStoreV2 } from "./EventStore.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/**
 * A child on another environment settles with its card through a connected T3 app, the path
 * t3_settle_thread takes there, and its own environment cascades to what is under it. With no
 * app relaying, or one without read and lifecycle access, remote children keep their state.
 */

// A card's settle time is this machine's clock; a remote child's is its own machine's.
const CLOCK_SKEW_MS = 60_000;

export interface SettlementChange {
  readonly threadId: ThreadId;
  readonly action: "settle" | "unsettle";
  /** The settle time the change applies or reverses. */
  readonly settledAt: DateTime.Utc;
}

/**
 * The chat and the local sub-runs under it that the local cascade passes through without an
 * event of their own: ones already settled at another time. Every other sub-run settles or
 * un-settles with its own event and is handled from that.
 */
const passThroughSubtree = Effect.fn("RemoteSettlementCascade.passThroughSubtree")(function* (
  change: SettlementChange,
) {
  const projections = yield* ProjectionStoreV2;
  const settledAtMs = DateTime.toEpochMillis(change.settledAt);
  const subtree = new Set<ThreadId>([change.threadId]);
  const pending = [change.threadId];
  for (let index = 0; index < pending.length; index++) {
    const children = yield* projections
      .getChildThreads(pending[index]!)
      .pipe(Effect.orElseSucceed(() => []));
    for (const child of children) {
      if (child.parentEnvironmentId != null || subtree.has(child.id)) continue;
      if (
        child.settledOverride !== "settled" ||
        child.settledAt == null ||
        (change.action === "settle" && DateTime.toEpochMillis(child.settledAt) === settledAtMs)
      ) {
        continue;
      }
      subtree.add(child.id);
      pending.push(child.id);
    }
  }
  return subtree;
});

/** Settles, or brings back, the children on other environments of the changed chats. */
export const cascadeToOtherEnvironments = Effect.fn("RemoteSettlementCascade.cascade")(function* (
  changes: ReadonlyArray<SettlementChange>,
) {
  if (changes.length === 0) return;
  const broker = yield* McpGatewayBroker;
  const local = (yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor).environmentId;
  const remotes = Object.entries((yield* broker.access).grants)
    .filter(
      ([id, scopes]) => id !== local && scopes.includes("read") && scopes.includes("lifecycle"),
    )
    .map(([id]) => EnvironmentId.make(id));
  if (remotes.length === 0) return;
  // Each remote child follows the change of the local chat it sits under.
  const owners = new Map<ThreadId, SettlementChange>();
  for (const change of changes) {
    for (const threadId of yield* passThroughSubtree(change)) owners.set(threadId, change);
  }
  for (const environmentId of remotes) {
    const listed = yield* broker.call("listThreads", [environmentId]).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Could not list another environment's chats", {
          environmentId,
          cause,
        }).pipe(Effect.as({ items: [] })),
      ),
    );
    for (const thread of listed.items) {
      if (thread.parentEnvironmentId !== local || thread.parentThreadId == null) continue;
      const change = owners.get(thread.parentThreadId);
      if (change === undefined) continue;
      // Un-settle returns only children that settled with the chat, not ones settled before it.
      if (
        change.action === "unsettle" &&
        (thread.settledAt == null ||
          DateTime.toEpochMillis(thread.settledAt) <
            DateTime.toEpochMillis(change.settledAt) - CLOCK_SKEW_MS)
      ) {
        continue;
      }
      // Settling a settled child again still cascades on its environment to what is under it.
      yield* broker
        .call(change.action === "settle" ? "settleThread" : "unsettleThread", [
          environmentId,
          thread.id,
        ])
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("Remote child kept its settlement", {
              threadId: thread.id,
              environmentId,
              cause,
            }),
          ),
        );
    }
  }
});

/** The settle time an explicit un-settle reverses; null when the chat had only aged out. */
const settledBefore = Effect.fn("RemoteSettlementCascade.settledBefore")(function* (
  threadId: ThreadId,
) {
  const events = yield* EventStoreV2;
  let previous: OrchestrationV2DomainEvent | undefined;
  yield* events
    .read({ threadId, eventType: "thread.settled" })
    .pipe(Stream.runForEach((stored) => Effect.sync(() => void (previous = stored.event))));
  return previous?.type === "thread.settled" && previous.payload.settlementSource !== "inactivity"
    ? (previous.payload.settledAt ?? null)
    : null;
});

const toChanges = Effect.fn("RemoteSettlementCascade.toChanges")(function* (
  event: OrchestrationV2DomainEvent,
) {
  const changes: Array<SettlementChange> = [];
  if (event.type === "thread.settled") {
    if (event.payload.settlementSource !== "inactivity" && event.payload.settledAt != null) {
      changes.push({
        threadId: event.threadId,
        action: "settle",
        settledAt: event.payload.settledAt,
      });
    }
  } else if (event.type === "thread.unsettled" && event.payload.settledOverride === "active") {
    // New activity also clears a settle; only an explicit un-settle cascades.
    const settledAt = yield* settledBefore(event.threadId);
    if (settledAt !== null)
      changes.push({ threadId: event.threadId, action: "unsettle", settledAt });
  }
  return changes;
});

// A cascade emits one event per chat in quick succession; one listing per batch covers them.
const BATCH_SIZE = 64;
const BATCH_WINDOW = Duration.millis(250);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestratorV2;
    yield* engine.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "thread.settled" || event.type === "thread.unsettled",
      ),
      Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
      Stream.runForEach((batch) =>
        Effect.forEach(batch, toChanges).pipe(
          Effect.flatMap((found) => cascadeToOtherEnvironments(found.flat())),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not carry settlement to other environments", { cause }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Remote settlement event stream failed", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
