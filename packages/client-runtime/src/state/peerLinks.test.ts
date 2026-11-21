import {
  EnvironmentId,
  WS_METHODS,
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
import { v2MessageRow, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createPeerLinkEnvironmentAtoms, linkThroughRoutes } from "./peerLinks.ts";

// regression: #40544 earlier messages vanished when a linked thread's view opened again
it.effect(
  "keeps loaded messages when a linked thread's view opens again on the same snapshot",
  () =>
    Effect.gen(function* () {
      const recent = v2MessageRow("Recent message", 2);
      const older = v2MessageRow("Earlier message", 1);
      const snapshot = (historyCursor: string): OrchestrationV2ThreadStreamItem => ({
        kind: "snapshot",
        snapshotSequence: 7,
        projection: { ...v2Projection, turnItems: [recent.item], visibleTurnItems: [recent] },
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
            return cursor === "before-recent"
              ? {
                  snapshotSequence: 7,
                  items: [older],
                  nextCursor: "before-earlier",
                  hasMoreHistory: true,
                }
              : { snapshotSequence: 7, items: [], nextCursor: null, hasMoreHistory: false };
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
      const links = createPeerLinkEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environment)),
      );
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      const views = yield* Queue.unbounded<LinkedThreadView>();
      const open = () =>
        registry.subscribe(links.threadView(target), (result) => {
          if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(views, result.value);
        });
      const visibleMessages = (view: LinkedThreadView) =>
        view.thread.projection?.visibleTurnItems.map((row) => row.sourceItemId);

      const unmount = open();
      const first = yield* Queue.take(subscriptions);
      yield* Queue.offer(first.items, snapshot("before-recent"));
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
      yield* Queue.offer(reopened.items, snapshot("before-recent"));
      const resumed = yield* Queue.take(views);
      expect(visibleMessages(resumed)).toEqual([older.sourceItemId, recent.sourceItemId]);
      // Paging goes on from where the closed view stopped, without reading the same page again.
      expect(resumed.thread.historyCursor).toBe("before-earlier");
      expect(requested).toEqual(["before-recent"]);

      // A snapshot of another window replaces the rows held for the old one.
      yield* Queue.offer(reopened.items, snapshot("new-window"));
      const refreshed = yield* Queue.take(views);
      expect(visibleMessages(refreshed)).toEqual([recent.sourceItemId]);
      expect(refreshed.thread.historyCursor).toBe("new-window");
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
