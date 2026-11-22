import {
  type GuestMessageId,
  type GuestShareId,
  type MilestoneActor,
  type MilestoneEvent,
  MilestoneId,
  type MilestoneInputKind,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as MilestoneHub from "./MilestoneHub.ts";

const inputKind = (kind: OrchestrationV2RuntimeRequest["kind"]): MilestoneInputKind | null => {
  switch (kind) {
    case "user_input":
    case "mcp-elicitation":
      return "user_input";
    case "command":
    case "file-read":
    case "file-change":
    case "permission":
      return "approval";
    default:
      return null;
  }
};

/** Turns orchestration events into thread, guest and pull request watch milestones. */
export class OrchestrationMilestones extends Context.Service<
  OrchestrationMilestones,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/milestones/OrchestrationMilestones") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const hub = yield* MilestoneHub.MilestoneHub;
  // A record updated again after a restart is not news unless its change is from after it.
  const since = yield* DateTime.now;
  const isNew = (at: DateTime.Utc | string) =>
    DateTime.isGreaterThanOrEqualTo(typeof at === "string" ? DateTime.makeUnsafe(at) : at, since);
  /** Each thread's waiting guest messages, so a resolution is told once and a closed link is seen. */
  const guestPending = new Map<ThreadId, Map<GuestMessageId, GuestShareId>>();

  const envelope = (
    id: string,
    thread: OrchestrationV2AppThread,
    occurredAt: DateTime.Utc,
    actor: MilestoneActor,
  ) => ({
    id: MilestoneId.make(id),
    occurredAt: DateTime.formatIso(occurredAt),
    projectId: thread.projectId,
    threadId: thread.id,
    parentThreadId: thread.lineage.parentThreadId,
    actor,
    isSubagentChild: thread.lineage.relationshipToParent === "subagent",
  });

  const guestMilestones = (
    thread: OrchestrationV2AppThread,
    occurredAt: DateTime.Utc,
  ): ReadonlyArray<MilestoneEvent> => {
    const share = thread.guestShare ?? null;
    const before = guestPending.get(thread.id) ?? new Map<GuestMessageId, GuestShareId>();
    const pending = new Map<GuestMessageId, GuestShareId>();
    const out: Array<MilestoneEvent> = [];
    const resolved = (
      shareId: GuestShareId,
      guestMessageId: GuestMessageId,
      resolution: "sent" | "dismissed" | "closed",
    ) =>
      out.push({
        ...envelope(`thread.guest_request_resolved:${guestMessageId}`, thread, occurredAt, {
          type: "user",
        }),
        type: "thread.guest_request_resolved",
        shareId,
        guestMessageId,
        resolution,
      });
    if (share !== null) {
      const guest: MilestoneActor = {
        type: "guest",
        id: share.id,
        ...(share.guestName === null ? {} : { label: share.guestName }),
      };
      for (const message of share.messages) {
        if (message.status !== "pending") {
          if (before.has(message.id)) resolved(share.id, message.id, message.status);
          continue;
        }
        pending.set(message.id, share.id);
        if (before.has(message.id) || !isNew(message.submittedAt)) continue;
        out.push({
          ...envelope(`thread.guest_request:${message.id}`, thread, occurredAt, guest),
          type: "thread.guest_request",
          shareId: share.id,
          guestMessageId: message.id,
        });
      }
    }
    // Gone from the share without an answer: the link was closed or replaced.
    for (const [guestMessageId, shareId] of before) {
      if (share?.messages.some((message) => message.id === guestMessageId) !== true) {
        resolved(shareId, guestMessageId, "closed");
      }
    }
    if (pending.size === 0) guestPending.delete(thread.id);
    else guestPending.set(thread.id, pending);
    return out;
  };

  // Runs for every domain event, token deltas included; most return before reading anything.
  const handle: OrchestrationMilestones["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      const out: Array<MilestoneEvent> = [];
      switch (event.type) {
        case "run.updated": {
          const run = event.payload;
          // A queued run cancelled before it started did no work worth telling of.
          if (run.startedAt === null || run.completedAt === null || !isNew(run.completedAt)) return;
          if (
            run.status !== "completed" &&
            run.status !== "failed" &&
            run.status !== "interrupted" &&
            run.status !== "cancelled"
          ) {
            return;
          }
          const thread = yield* projections.getThread(event.threadId);
          out.push({
            ...envelope(`thread.run_settled:${run.id}`, thread, run.completedAt, {
              type: "agent",
              id: run.providerInstanceId,
            }),
            type: "thread.run_settled",
            runId: run.id,
            outcome: run.status,
          });
          break;
        }
        case "runtime-request.updated": {
          const request = event.payload;
          const kind = inputKind(request.kind);
          if (kind === null) return;
          if (request.status === "pending") {
            if (!isNew(request.createdAt)) return;
            const thread = yield* projections.getThread(event.threadId);
            out.push({
              ...envelope(`thread.needs_input:${request.id}`, thread, request.createdAt, {
                type: "agent",
              }),
              type: "thread.needs_input",
              requestId: request.id,
              kind,
            });
          } else {
            const at = request.resolvedAt ?? event.occurredAt;
            if (!isNew(at)) return;
            const thread = yield* projections.getThread(event.threadId);
            out.push({
              ...envelope(`thread.input_resolved:${request.id}`, thread, at, {
                type: request.status === "resolved" ? "user" : "system",
              }),
              type: "thread.input_resolved",
              requestId: request.id,
              kind,
              resolution: request.status,
            });
          }
          break;
        }
        case "thread.guest-share-updated":
          out.push(...guestMilestones(event.payload, event.occurredAt));
          break;
        case "message.updated": {
          const message = event.payload;
          const source = message.notification?.source;
          if (source?.kind !== "monitor" || source.pullRequest === undefined) return;
          if (!isNew(message.createdAt)) return;
          const stamps = [source.pullRequest, ...(source.otherPullRequests ?? [])];
          const thread = yield* projections.getThread(event.threadId);
          out.push({
            ...envelope(`pr.watch_wake:${message.id}`, thread, message.createdAt, {
              type: "system",
              label: "pull request watch",
            }),
            type: "pr.watch_wake",
            pullRequests: stamps.map(({ host, repository, number }) => ({
              host,
              repository,
              number,
            })),
            outcome: message.notification!.outcome,
            summary: message.notification!.summary,
            watchEnded: stamps.some((stamp) => stamp.watchEnded === true),
          });
          break;
        }
        default:
          return;
      }
      yield* Effect.forEach(out, hub.publish, { discard: true });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("deriving a milestone failed", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start: OrchestrationMilestones["Service"]["start"] = Effect.fn(
    "OrchestrationMilestones.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration milestone stream failed", { cause }),
        ),
      ),
    );
  });

  return OrchestrationMilestones.of({ start, handle });
});

export const layer = Layer.effect(OrchestrationMilestones, make);
