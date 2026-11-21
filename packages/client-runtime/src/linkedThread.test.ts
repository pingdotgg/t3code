import {
  EnvironmentId,
  EventId,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadStreamItem,
  type PeerLinkClientPairingResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  connectLinkedEnvironment,
  followLinkedThread,
  keepLinkedThreadView,
  LINKED_THREAD_RETRY_MS,
  type LinkedThreadView,
  ownEnvironmentConnection,
  resolveLinkedThreadOpen,
} from "./linkedThread.ts";
import { v2Now, v2Projection } from "./state/orchestrationV2TestFixtures.ts";

const snapshot = (
  snapshotSequence: number,
  historyCursor: string | null = null,
): OrchestrationV2ThreadStreamItem => ({
  kind: "snapshot",
  snapshotSequence,
  projection: v2Projection,
  historyCursor,
  hasMoreHistory: historyCursor !== null,
});

const retitled = (sequence: number, title: string): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event:${sequence}`),
    type: "thread.metadata-updated",
    threadId: v2Projection.thread.id,
    occurredAt: v2Now,
    payload: { ...v2Projection.thread, title },
  },
});

const failure = (reason: string) => ({ _tag: "PeerLinkThreadReadError", reason });
const titleOf = (view: LinkedThreadView) => view.thread.projection?.thread.title ?? null;

it.effect("keeps what it read while a linked environment is out of reach, and asks it again", () =>
  Effect.gen(function* () {
    const attempts = [
      Stream.make(snapshot(1), retitled(2, "Renamed")).pipe(
        Stream.concat(Stream.fail(failure("unreachable"))),
      ),
      Stream.make(snapshot(5)).pipe(Stream.concat(Stream.fail(failure("expired")))),
    ];
    let opened = 0;
    const views = yield* Queue.unbounded<LinkedThreadView>();
    const following = yield* followLinkedThread({
      items: Stream.suspend(() => attempts[opened++]!),
      historyPage: () => Effect.die("unused"),
    }).pipe(
      Stream.runForEach((view) => Queue.offer(views, view)),
      Effect.flip,
      Effect.forkChild,
    );

    expect(titleOf(yield* Queue.take(views))).toBe(v2Projection.thread.title);
    expect(titleOf(yield* Queue.take(views))).toBe("Renamed");
    // Out of reach: the thread stays as read, with the reason beside it.
    const waiting = yield* Queue.take(views);
    expect([titleOf(waiting), waiting.error]).toEqual(["Renamed", failure("unreachable")]);
    expect(opened).toBe(1);

    yield* TestClock.adjust(LINKED_THREAD_RETRY_MS);
    // It answers again: its snapshot replaces the thread and clears the reason.
    const back = yield* Queue.take(views);
    expect([titleOf(back), back.error, back.thread.sequence]).toEqual([
      v2Projection.thread.title,
      null,
      5,
    ]);
    // A link that expired cannot come back by waiting, so the stream ends with it.
    expect(yield* Fiber.join(following)).toEqual(failure("expired"));
    expect(opened).toBe(2);
  }),
);

it.effect("keeps the thread a view showed while its reopened stream has read nothing", () =>
  Effect.gen(function* () {
    const attempts = [
      Stream.make(snapshot(1, "cursor-1"), retitled(2, "Renamed")),
      // The view closed and opened again while the linked environment was out of reach.
      Stream.fail(failure("unreachable")),
      Stream.make(snapshot(5)).pipe(Stream.concat(Stream.never)),
    ];
    let opened = 0;
    const follow = () =>
      followLinkedThread({
        items: Stream.suspend(() => attempts[opened++]!),
        historyPage: () => Effect.die("unused"),
      });
    let kept: LinkedThreadView | null = null;
    yield* follow().pipe(
      Stream.runForEach((view) => Effect.sync(() => (kept = keepLinkedThreadView(kept, view)))),
    );

    const views = yield* Queue.unbounded<LinkedThreadView>();
    yield* follow().pipe(
      Stream.runForEach((view) => Queue.offer(views, keepLinkedThreadView(kept, view))),
      Effect.forkScoped,
    );
    const waiting = yield* Queue.take(views);
    expect([titleOf(waiting), waiting.error]).toEqual(["Renamed", failure("unreachable")]);
    // Earlier turns belong to a stream that is gone, so none are offered until one is back.
    expect(waiting.thread.historyCursor).toBeNull();

    yield* TestClock.adjust(LINKED_THREAD_RETRY_MS);
    const back = yield* Queue.take(views);
    expect([titleOf(back), back.error, back.thread.sequence]).toEqual([
      v2Projection.thread.title,
      null,
      5,
    ]);
  }).pipe(Effect.scoped),
);

it.effect("loads the turns before a snapshot's window once per request", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const page: OrchestrationV2ThreadHistoryPage = {
      snapshotSequence: 1,
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    };
    const views = yield* Queue.unbounded<LinkedThreadView>();
    yield* followLinkedThread({
      items: Stream.make(snapshot(1, "cursor-1")).pipe(Stream.concat(Stream.never)),
      historyPage: (cursor) =>
        Effect.sync(() => {
          asked.push(cursor);
          return page;
        }),
    }).pipe(
      Stream.runForEach((view) => Queue.offer(views, view)),
      Effect.forkScoped,
    );

    const shown = yield* Queue.take(views);
    expect(shown.thread.historyCursor).toBe("cursor-1");
    shown.loadEarlier();
    // A second tap while the page loads asks for nothing more.
    shown.loadEarlier();
    expect((yield* Queue.take(views)).history).toEqual({ loading: true, failed: false });
    const loaded = yield* Queue.take(views);
    expect([loaded.history.loading, loaded.thread.historyCursor]).toEqual([false, null]);
    // Nothing is left to load.
    loaded.loadEarlier();
    expect(asked).toEqual(["cursor-1"]);
  }).pipe(Effect.scoped),
);

describe("resolveLinkedThreadOpen", () => {
  const here = EnvironmentId.make("env-here");
  const laptop = EnvironmentId.make("env-laptop");
  const open = (enabled: boolean, linked: boolean) =>
    resolveLinkedThreadOpen({
      environmentId: laptop,
      viaEnvironmentId: here,
      own: ownEnvironmentConnection({
        entry: { enabled },
        connection: { phase: enabled ? "connected" : "disconnected" },
      }),
      linked,
    });

  it("never opens a thread in a saved environment that is switched off", () => {
    expect(open(true, true)).toBe("direct");
    expect(open(false, true)).toBe("linked");
    expect(open(false, false)).toBe("unavailable");
  });
});

describe("connectLinkedEnvironment", () => {
  const lan = "http://192.168.1.20:3773";
  const tailnet = "https://vm.tail.ts.net";
  const target = {
    environmentId: EnvironmentId.make("environment-vm"),
    label: "VM",
    urls: [lan, tailnet],
  };
  const credential: PeerLinkClientPairingResult = {
    type: "credential",
    ...target,
    credential: "ONE-TIME",
    expiresAt: DateTime.makeUnsafe(0),
  };
  const connect = (
    pairing: PeerLinkClientPairingResult | null,
    reachable: ReadonlyArray<string>,
    paired = true,
  ) => {
    const pairs: Array<{ host: string; pairingCode: string }> = [];
    return connectLinkedEnvironment({
      label: "vm (saved name)",
      requestPairing: async () => pairing,
      reaches: async (host) => reachable.includes(host),
      pair: async (input) => {
        pairs.push(input);
        return paired;
      },
    }).then((outcome) => ({ outcome, pairs }));
  };

  it("redeems the pairing at the first address this device reaches", async () => {
    expect(await connect(credential, [tailnet])).toEqual({
      outcome: { type: "connected" },
      pairs: [{ host: tailnet, pairingCode: "ONE-TIME" }],
    });
    expect((await connect(credential, [tailnet, lan])).pairs[0]?.host).toBe(lan);
  });

  it("says the machine is out of reach, and spends nothing, when no address answers", async () => {
    expect(await connect(credential, [])).toEqual({
      outcome: { type: "unreachable", label: "VM" },
      pairs: [],
    });
  });

  it("leaves pairing to the user when the link cannot do it, with an address filled in", async () => {
    const unsupported: PeerLinkClientPairingResult = {
      type: "unsupported",
      reason: "link_access",
      ...target,
    };
    const manual = (host: string | null) => ({
      outcome: { type: "manual", label: "VM", host },
      pairs: [],
    });
    expect(await connect(unsupported, [tailnet])).toEqual(manual(tailnet));
    // An address the user can correct beats an empty field.
    expect(await connect(unsupported, [])).toEqual(manual(lan));
    expect(await connect({ ...unsupported, urls: [] }, [])).toEqual(manual(null));
    // The linking environment never answered, so only the client's own name is known.
    expect((await connect(null, [lan])).outcome).toEqual({
      type: "manual",
      label: "vm (saved name)",
      host: null,
    });
    // The one-time pairing was refused where it was redeemed.
    expect((await connect(credential, [lan], false)).outcome).toEqual({
      type: "manual",
      label: "VM",
      host: lan,
    });
  });
});
