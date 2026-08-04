import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PINNED_AT = "1969-12-30T00:00:00.000Z";

function makeReadModel(input: {
  readonly pinnedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: input.settledOverride ?? null,
        settledAt: input.settledAt ?? (input.settledOverride === "settled" ? NOW : null),
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedAt ?? (input.snoozedUntil != null ? PINNED_AT : null),
        pinnedAt: input.pinnedAt ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("pinned thread decider", (it) => {
  it.effect("pins a thread, stamping pinnedAt and updatedAt together", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("cmd-pin"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.pinned");
      if (events[0]?.type === "thread.pinned") {
        expect(events[0].payload.pinnedAt).toBe(events[0].payload.updatedAt);
      }
    }),
  );

  it.effect("re-pinning preserves the original pinnedAt and updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("cmd-pin-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ pinnedAt: PINNED_AT }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.pinned");
      if (events[0]?.type === "thread.pinned") {
        expect(events[0].payload.pinnedAt).toBe(PINNED_AT);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("unpins a pinned thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unpin",
          commandId: CommandId.make("cmd-unpin"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ pinnedAt: PINNED_AT }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.unpinned");
      if (events[0]?.type === "thread.unpinned") {
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("unpinning an unpinned thread preserves updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unpin",
          commandId: CommandId.make("cmd-unpin-noop"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.unpinned");
      if (events[0]?.type === "thread.unpinned") {
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("pinning a settled thread also un-settles it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("cmd-pin-settled"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ settledOverride: "settled" }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual(["thread.pinned", "thread.unsettled"]);
      const unsettled = events.find((entry) => entry.type === "thread.unsettled");
      if (unsettled?.type === "thread.unsettled") {
        expect(unsettled.payload.reason).toBe("user");
      }
    }),
  );

  it.effect("pinning a snoozed thread also wakes it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("cmd-pin-snoozed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ snoozedUntil: "1970-01-02T09:00:00.000Z" }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual(["thread.pinned", "thread.unsnoozed"]);
    }),
  );

  it.effect("pinning an unparked thread emits only thread.pinned", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("cmd-pin-plain"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual(["thread.pinned"]);
    }),
  );

  it.effect("settling a pinned thread also unpins it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pinned"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ pinnedAt: PINNED_AT }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual(["thread.settled", "thread.unpinned"]);
    }),
  );

  it.effect("settling an unpinned thread emits no unpin event", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-unpinned"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events.map((entry) => entry.type)).toEqual(["thread.settled"]);
    }),
  );

  it.effect("rejects pinning an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pin",
          commandId: CommandId.make("cmd-pin-archived"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
