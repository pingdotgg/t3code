import { ProjectId, ThreadId, extensionWorkspaceRevision } from "@t3tools/contracts";
import type { OrchestrationEvent, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import { WORKSPACE_READ, WORKSPACE_CHANGES_API } from "@t3tools/extension-sdk/catalogue";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import { createWorkspaceChangesApiProvider } from "./workspaceChangesApi.ts";

const context = {
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision("/workspace", null),
} as const;
const metadata: HostApiInvocationMetadata = {
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: "t3.host-workspace-changes",
  providerGeneration: 1,
  callerGenerations: [],
};

let eventSequence = 0;
let activitySequence = 0;
function activity(input: {
  readonly id?: string;
  readonly kind?: string;
  readonly itemType?: string;
  readonly status?: string;
  readonly turnId?: string | null;
}): OrchestrationThreadActivity {
  activitySequence += 1;
  return {
    id: input.id ?? `event-${activitySequence}`,
    kind: input.kind ?? "tool.completed",
    tone: "tool",
    summary: "activity",
    turnId: input.turnId ?? null,
    sequence: activitySequence,
    createdAt: `2026-09-13T00:00:${String(activitySequence % 60).padStart(2, "0")}.000Z`,
    payload: {
      ...(input.itemType === undefined ? {} : { itemType: input.itemType }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  } as unknown as OrchestrationThreadActivity;
}
function event(type: string, payload: unknown): OrchestrationEvent {
  eventSequence += 1;
  return {
    type,
    payload,
    sequence: eventSequence,
    eventId: `evt-${eventSequence}`,
    aggregateKind: "thread",
    aggregateId: "thread",
    occurredAt: `2026-09-13T01:00:${String(eventSequence % 60).padStart(2, "0")}.000Z`,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as unknown as OrchestrationEvent;
}
const appended = (value: OrchestrationThreadActivity, threadId = "thread") =>
  event("thread.activity-appended", { threadId, activity: value });

function fixture(options: {
  readonly activities?: OrchestrationThreadActivity[];
  readonly turns?: readonly { turnId: string | null; checkpointTurnCount: number | null }[];
  readonly threadDeleted?: boolean;
}) {
  const activities = [...(options.activities ?? [])];
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the provider's subscribe API is a promise-based async iterator; the fixture's PubSub outlives any single it.effect run.
  const pubsub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const provider = createWorkspaceChangesApiProvider({
    environmentId: "env",
    projects: {
      getById: (input: { projectId: ProjectId }) =>
        Effect.succeed(
          Option.some({ projectId: input.projectId, workspaceRoot: "/workspace", deletedAt: null }),
        ),
    } as never,
    threads: {
      getById: (_input: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: null,
            deletedAt: options.threadDeleted ? "2026-09-13T00:00:00.000Z" : null,
          }),
        ),
    } as never,
    activities: {
      listByThreadId: () =>
        Effect.succeed(activities.map((row) => ({ ...row, activityId: row.id }))),
    } as never,
    turns: {
      listByThreadId: () => Effect.succeed([...(options.turns ?? [])]),
    } as never,
    events: {
      subscribeDomainEvents: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
    },
  });
  return {
    provider,
    activities,
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- publishing must resolve before the test's next() poll, which it.effect cannot interleave with.
    publish: (value: OrchestrationEvent) => Effect.runPromise(PubSub.publish(pubsub, value)),
  };
}

function subscribe(
  f: ReturnType<typeof fixture>,
  input: { threadId: string } = { threadId: "thread" },
  subscribeContext: typeof context = context,
) {
  const stream = f.provider.subscribe!(
    "subscribeChanges",
    input,
    subscribeContext,
    new AbortController().signal,
    metadata,
  );
  return stream[Symbol.asyncIterator]();
}

async function nextValue(iterator: AsyncIterator<unknown>) {
  const next = await iterator.next();
  if (next.done) throw new Error("stream ended");
  return next.value as { type: string; value: unknown };
}

it("declares the workspace read grant on the stream contract", () => {
  const stream = WORKSPACE_CHANGES_API.streams?.find((item) => item.name === "subscribeChanges");
  expect(stream?.requiredGrants).toEqual([WORKSPACE_READ]);
});

it("snapshots the seeded fold then bumps on qualifying appends only", async () => {
  const f = fixture({
    activities: [activity({ itemType: "file_change", id: "seeded" })],
  });
  const iterator = subscribe(f);
  expect(await nextValue(iterator)).toEqual({
    type: "snapshot",
    value: { kind: "snapshot", mutationSeq: 1 },
  });
  await f.publish(appended(activity({ itemType: "message" })));
  await f.publish(appended(activity({ itemType: "command_execution", id: "cmd" })));
  expect(await nextValue(iterator)).toMatchObject({
    type: "data",
    value: { kind: "mutation", mutationSeq: 2, kinds: ["command_execution"] },
  });
  await f.publish(appended(activity({ itemType: "file_change", id: "fc" })));
  expect(await nextValue(iterator)).toMatchObject({
    type: "data",
    value: { kind: "mutation", mutationSeq: 3, kinds: ["file_change"] },
  });
});

it("ignores in-progress tool.updated rows and counts terminal ones", async () => {
  const f = fixture({});
  const iterator = subscribe(f);
  await nextValue(iterator);
  await f.publish(
    appended(
      activity({ kind: "tool.updated", itemType: "file_change", status: "inProgress", id: "u" }),
    ),
  );
  await f.publish(appended(activity({ itemType: "message", id: "m" })));
  await f.publish(
    appended(
      activity({ kind: "tool.updated", itemType: "file_change", status: "completed", id: "u" }),
    ),
  );
  expect(await nextValue(iterator)).toMatchObject({
    type: "data",
    value: { kind: "mutation", mutationSeq: 1, kinds: ["file_change"] },
  });
});

it("ignores events for other threads", async () => {
  const f = fixture({});
  const iterator = subscribe(f);
  await nextValue(iterator);
  await f.publish(appended(activity({ itemType: "file_change", id: "foreign" }), "other-thread"));
  await f.publish(appended(activity({ itemType: "file_change", id: "own" })));
  expect(await nextValue(iterator)).toMatchObject({
    type: "data",
    value: { mutationSeq: 1 },
  });
});

it("bumps the sequence when a revert drops qualifying rows", async () => {
  const f = fixture({
    activities: [
      activity({ itemType: "file_change", id: "a", turnId: "turn-1" }),
      activity({ itemType: "command_execution", id: "b", turnId: "turn-2" }),
    ],
    turns: [
      { turnId: "turn-1", checkpointTurnCount: 1 },
      { turnId: "turn-2", checkpointTurnCount: 2 },
    ],
  });
  const iterator = subscribe(f);
  expect(await nextValue(iterator)).toMatchObject({ value: { mutationSeq: 1 } });
  await f.publish(event("thread.reverted", { threadId: "thread", turnCount: 1 }));
  expect(await nextValue(iterator)).toMatchObject({
    type: "data",
    value: { kind: "mutation", mutationSeq: 2 },
  });
  // A revert that retains every qualifying row does not bump.
  await f.publish(event("thread.reverted", { threadId: "thread", turnCount: 5 }));
  await f.publish(appended(activity({ itemType: "file_change", id: "c" })));
  expect(await nextValue(iterator)).toMatchObject({ value: { mutationSeq: 3 } });
});

it("closes with a recoverable overflow once the queue bound is exceeded", async () => {
  const f = fixture({});
  const iterator = subscribe(f);
  await nextValue(iterator);
  for (let index = 0; index < 80; index += 1)
    await f.publish(appended(activity({ itemType: "file_change" })));
  let closed: { type: string; value: unknown } | null = null;
  for (let index = 0; index < 80 && closed === null; index += 1) {
    const frame = await nextValue(iterator);
    if (frame.type === "closed") closed = frame;
  }
  expect(closed).toMatchObject({ type: "closed", value: { reason: "overflow" } });
});

it("re-delivers the latest sequence on resubscription, including mutations folded while unwatched", async () => {
  const f = fixture({});
  const first = subscribe(f);
  await nextValue(first);
  await f.publish(appended(activity({ itemType: "file_change", id: "live" })));
  expect(await nextValue(first)).toMatchObject({ value: { mutationSeq: 1 } });
  await first.return!();
  // A mutation lands while no subscriber is attached; the fold re-seeds from
  // the projection rows and the fresh snapshot reports the advanced seq.
  f.activities.push(activity({ itemType: "command_execution", id: "late" }));
  const second = subscribe(f);
  expect(await nextValue(second)).toEqual({
    type: "snapshot",
    value: { kind: "snapshot", mutationSeq: 2 },
  });
});

it("denies foreign threads and missing thread scope", async () => {
  const f = fixture({});
  expect(() => subscribe(f, { threadId: "other-thread" })).toThrow("another thread");
  const noThread = {
    ...context,
    resource: { ...context.resource, threadId: undefined },
  } as unknown as typeof context;
  expect(() => subscribe(f, { threadId: "thread" }, noThread)).toThrow("thread scope");
});

it("denies a deleted thread through scope resolution", async () => {
  const f = fixture({ threadDeleted: true });
  const iterator = subscribe(f);
  await expect(iterator.next()).rejects.toBeDefined();
});

it("rejects resume cursors", () => {
  const f = fixture({});
  expect(() =>
    f.provider.subscribe!(
      "subscribeChanges",
      { threadId: "thread" },
      context,
      new AbortController().signal,
      metadata,
      "cursor-1",
    ),
  ).toThrow("resume");
});
