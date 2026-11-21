import * as NodeBuffer from "node:buffer";
import {
  EnvironmentId,
  EventId,
  MessageId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadStreamItem,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { LinkedThreadView } from "../linkedThread.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createPeerLinkEnvironmentAtoms, linkThroughRoutes } from "./peerLinks.ts";

function messageRow(text: string, ordinal: number): OrchestrationV2ProjectedTurnItem {
  const itemId = TurnItemId.make(text);
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: v2ThreadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(text),
      inputIntent: "turn_start",
      text,
      attachments: [],
    },
  };
}

it.effect.each([
  [null, 8],
  ["before-earlier", 7],
] as const)(
  "keeps loaded messages across a linked-thread subscription reopen (next cursor %s)",
  ([nextCursor, refreshedSequence]) =>
    Effect.gen(function* () {
      const recent = messageRow("Recent message", 2);
      const older = messageRow("Earlier message", 1);
      const snapshot = (
        snapshotSequence: number,
        historyCursor: string,
      ): OrchestrationV2ThreadStreamItem => ({
        kind: "snapshot",
        snapshotSequence,
        projection: {
          ...v2Projection,
          turnItems: [recent.item],
          visibleTurnItems: [recent],
        },
        historyCursor,
        hasMoreHistory: true,
      });
      const subscriptions = yield* Queue.unbounded<{
        items: Queue.Queue<OrchestrationV2ThreadStreamItem>;
        stopped: Deferred.Deferred<void>;
      }>();
      const requested: string[] = [];
      const client = {
        [WS_METHODS.peerLinksSubscribeThread]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
              const stopped = yield* Deferred.make<void>();
              yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
              yield* Queue.offer(subscriptions, { items, stopped });
              return Stream.fromQueue(items);
            }),
          ),
        [WS_METHODS.peerLinksThreadHistoryPage]: ({ cursor }: { cursor: string }) =>
          Effect.sync((): OrchestrationV2ThreadHistoryPage => {
            requested.push(cursor);
            return {
              snapshotSequence: 7,
              items: cursor === "before-recent" ? [older] : [],
              nextCursor: cursor === "before-recent" ? nextCursor : null,
              hasMoreHistory: cursor === "before-recent" && nextCursor !== null,
            };
          }),
      } as unknown as RpcSession["client"];
      const target = {
        environmentId: EnvironmentId.make("via"),
        input: { environmentId: EnvironmentId.make("linked"), threadId: v2ThreadId },
      };
      const supervisor = EnvironmentSupervisor.of({
        target: { environmentId: target.environmentId, label: "Via" },
        session: yield* SubscriptionRef.make(Option.some({ client })),
      } as unknown as EnvironmentSupervisor["Service"]);
      const environment = EnvironmentRegistry.of({
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as Pick<EnvironmentRegistry["Service"], "followStream"> as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environment));
      const links = createPeerLinkEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      const live = links.threadView(target);
      const kept = links.lastThreadView(target);
      const views = yield* Queue.unbounded<LinkedThreadView>();
      const open = () =>
        registry.subscribe(live, (result) => {
          if (AsyncResult.isSuccess(result)) {
            const view = registry.get(kept);
            if (view?.thread.projection) Queue.offerUnsafe(views, view);
          }
        });
      const visibleMessages = (view: LinkedThreadView) =>
        view.thread.projection?.visibleTurnItems.map((row) => row.sourceItemId);

      const unmount = open();
      const first = yield* Queue.take(subscriptions);
      yield* Queue.offer(first.items, snapshot(7, "before-recent"));
      (yield* Queue.take(views)).loadEarlier();
      yield* Queue.take(views); // Loading.
      expect(visibleMessages(yield* Queue.take(views))).toEqual([
        older.sourceItemId,
        recent.sourceItemId,
      ]);
      unmount();
      yield* Deferred.await(first.stopped);

      open();
      const reopened = yield* Queue.take(subscriptions);
      yield* Queue.offer(reopened.items, snapshot(7, "before-recent"));
      const resumed = yield* Queue.take(views);
      expect(visibleMessages(resumed)).toEqual([older.sourceItemId, recent.sourceItemId]);
      expect(resumed.thread.historyCursor).toBe(nextCursor);
      expect(requested).toEqual(["before-recent"]);
      if (nextCursor !== null) {
        resumed.loadEarlier();
        yield* Queue.take(views); // Loading.
        expect((yield* Queue.take(views)).thread.historyCursor).toBeNull();
        expect(requested).toEqual(["before-recent", nextCursor]);
      }

      yield* Queue.offer(reopened.items, snapshot(refreshedSequence, "new-window"));
      const refreshed = yield* Queue.take(views);
      expect(visibleMessages(refreshed)).toEqual([recent.sourceItemId]);
      expect(refreshed.thread.historyCursor).toBe("new-window");
    }).pipe(Effect.scoped),
);

it.effect.each([
  "live update",
  "away update",
  "window moves",
  "history removed",
  "route restart",
] as const)("shows the current linked history on reopen (%s)", (change) =>
  Effect.gen(function* () {
    const recent = messageRow("Recent message", 3);
    const older = messageRow("Earlier message", 2);
    const oldest = messageRow("Oldest message", 1);
    const latest = messageRow("Latest message", 4);
    const cursorAt = (sequence: number, row: OrchestrationV2ProjectedTurnItem) =>
      NodeBuffer.Buffer.from(
        JSON.stringify({
          v: 1,
          seq: sequence,
          st: row.sourceThreadId,
          si: row.sourceItemId,
          p: row.item.ordinal - 1,
        }),
      ).toString("base64url");
    const snapshot = (
      snapshotSequence: number,
      title: string,
      row = recent,
    ): OrchestrationV2ThreadStreamItem => ({
      kind: "snapshot",
      snapshotSequence,
      projection: {
        ...v2Projection,
        thread: { ...v2Projection.thread, title },
        turnItems: [row.item],
        visibleTurnItems: [row],
      },
      historyCursor: cursorAt(snapshotSequence, row),
      hasMoreHistory: true,
    });
    const subscriptions = yield* Queue.unbounded<{
      items: Queue.Queue<OrchestrationV2ThreadStreamItem>;
      stopped: Deferred.Deferred<void>;
    }>();
    const requested: string[] = [];
    const client = {
      [WS_METHODS.peerLinksSubscribeThread]: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
            const stopped = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
            yield* Queue.offer(subscriptions, { items, stopped });
            return Stream.fromQueue(items);
          }),
        ),
      [WS_METHODS.peerLinksThreadHistoryPage]: ({ cursor }: { cursor: string }) =>
        Effect.sync((): OrchestrationV2ThreadHistoryPage => {
          requested.push(cursor);
          const revision = cursor === cursorAt(7, recent) ? 7 : 8;
          return change === "history removed" && revision === 8
            ? { snapshotSequence: 8, items: [oldest], nextCursor: null, hasMoreHistory: false }
            : {
                snapshotSequence: revision,
                items: cursor === cursorAt(8, latest) ? [older, recent] : [older],
                nextCursor: cursorAt(revision, older),
                hasMoreHistory: true,
              };
        }),
    } as unknown as RpcSession["client"];
    const target = {
      environmentId: EnvironmentId.make("via"),
      input: { environmentId: EnvironmentId.make("linked"), threadId: v2ThreadId },
    };
    const supervisor = EnvironmentSupervisor.of({
      target: { environmentId: target.environmentId, label: "Via" },
      session: yield* SubscriptionRef.make(Option.some({ client })),
    } as unknown as EnvironmentSupervisor["Service"]);
    const route = yield* SubscriptionRef.make(0);
    const environment = EnvironmentRegistry.of({
      followStream: (_id, stream) =>
        SubscriptionRef.changes(route).pipe(
          Stream.switchMap(() => Stream.provideService(stream, EnvironmentSupervisor, supervisor)),
        ),
    } as Pick<EnvironmentRegistry["Service"], "followStream"> as EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environment));
    const links = createPeerLinkEnvironmentAtoms(runtime);
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (registry) => Effect.sync(() => registry.dispose()),
    );
    const views = yield* Queue.unbounded<LinkedThreadView>();
    const open = () =>
      registry.subscribe(links.threadView(target), (result) => {
        if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(views, result.value);
      });
    const unmount = open();
    const first = yield* Queue.take(subscriptions);
    yield* Queue.offer(first.items, snapshot(7, "Original"));
    (yield* Queue.take(views)).loadEarlier();
    yield* Queue.take(views); // Loading.
    expect((yield* Queue.take(views)).thread.historyCursor).toBe(cursorAt(7, older));

    if (change === "live update") {
      yield* Queue.offer(first.items, {
        kind: "event",
        sequence: 8,
        event: {
          id: EventId.make("retitle"),
          type: "thread.metadata-updated",
          threadId: v2ThreadId,
          occurredAt: v2Now,
          payload: { ...v2Projection.thread, title: "Renamed" },
        },
      });
      expect((yield* Queue.take(views)).thread.sequence).toBe(8);
    }
    if (change === "route restart") {
      yield* SubscriptionRef.set(route, 1);
    } else {
      unmount();
      yield* Deferred.await(first.stopped);
      open();
    }
    const reopened = yield* Queue.take(subscriptions);
    const sequence = change === "route restart" ? 7 : 8;
    const title = change === "route restart" ? "Original" : "Renamed";
    const moved = change === "window moves";
    yield* Queue.offer(reopened.items, snapshot(sequence, title, moved ? latest : recent));
    const resumed = yield* Queue.take(views);
    const removed = change === "history removed";
    const refetched = removed || moved || change === "away update";
    expect(resumed.thread.projection?.thread.title).toBe(title);
    expect(resumed.thread.projection?.visibleTurnItems.map((row) => row.sourceItemId)).toEqual([
      (removed ? oldest : older).sourceItemId,
      recent.sourceItemId,
      ...(moved ? [latest.sourceItemId] : []),
    ]);
    expect(resumed.thread.historyCursor).toBe(removed ? null : cursorAt(refetched ? 8 : 7, older));
    expect(requested).toEqual(
      refetched
        ? [cursorAt(7, recent), cursorAt(8, moved ? latest : recent)]
        : [cursorAt(7, recent)],
    );
  }).pipe(Effect.scoped),
);

const now = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");
const id = (value: string) => EnvironmentId.make(value);

const link = (target: string, overrides: Partial<PeerLinkSummary> = {}): PeerLinkSummary => ({
  environmentId: id(target),
  label: target,
  urls: [`https://${target}.example`],
  access: "full-access",
  status: "reachable",
  linkedAt: now,
  lastReachedAt: now,
  lastError: null,
  expiresAt: DateTime.makeUnsafe("2026-12-20T00:00:00.000Z"),
  ...overrides,
});

describe("linkThroughRoutes", () => {
  it("offers only machines another environment reaches over a full-access link that answers", () => {
    const routes = linkThroughRoutes({
      sourceEnvironmentId: id("source"),
      hosts: [
        { environmentId: id("source"), links: [link("own")] },
        {
          environmentId: id("via"),
          links: [
            link("open"),
            link("source"),
            link("supervised", { access: "approval-required" }),
            link("down", { status: "unreachable" }),
            link("lapsed", { expiresAt: now }),
          ],
        },
        { environmentId: id("later"), links: [link("open")] },
      ],
      now,
    });
    expect([...routes.values()]).toEqual([
      {
        viaEnvironmentId: id("via"),
        environmentId: id("open"),
        label: "open",
        urls: ["https://open.example"],
      },
    ]);
  });
});
