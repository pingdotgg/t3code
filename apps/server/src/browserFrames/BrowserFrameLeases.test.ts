import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  BROWSER_FRAME_TICKET_TTL_MS,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import {
  type BrowserFrameAuthority,
  layer as BrowserFrameLeasesLayer,
  make as BrowserFrameLeasesMake,
  BrowserFrameLeases,
} from "./BrowserFrameLeases.ts";

const session = {
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread-a"),
  serverEpoch: "epoch-1",
  tabId: PreviewTabId.make("tab-1"),
};

const sessionAuthority = (sessionId: string, connectionId = "conn-1"): BrowserFrameAuthority => ({
  kind: "session",
  sessionId: AuthSessionId.make(sessionId),
  subject: "user",
  connectionId,
  grants: ["orchestration.read"],
});

const extensionAuthority = (
  principalId: string,
  leafId = "ext-leaf",
): BrowserFrameAuthority & { kind: "extension" } => ({
  kind: "extension",
  principalKind: "environment-session",
  principalId,
  subject: "user",
  rootCallerId: "ext-root",
  callerId: leafId,
  callerGenerations: [{ pluginId: leafId, contentHash: "hash-1", installationGeneration: 1 }],
  context: { resource: { projectId: "proj-1" } },
  grants: ["browser.frames"],
});

const issue = (authority: BrowserFrameAuthority) => ({
  authority,
  session,
  engineGeneration: "gen-1",
  hostClientId: "host-a",
  hostConnectionId: "host-conn-1",
});

const TestLayer = Layer.provideMerge(BrowserFrameLeasesLayer, NodeServices.layer);

// Sweep tests need the explicit `sweep()` to be the collector — a 30s idle
// interval would fire during a 5-minute TestClock jump and race it.
const SlowSweepLayer = Layer.provideMerge(
  Layer.effect(BrowserFrameLeases, BrowserFrameLeasesMake({ sweepInterval: "1 hour" })),
  NodeServices.layer,
);

describe("BrowserFrameLeases", () => {
  it.effect("mints a stream ticket that verifies with its authority and tuple", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const authority = sessionAuthority("sess-a");
      const issued = Option.getOrThrow(yield* leases.issueStreamTicket(issue(authority)));
      expect(issued.ticket.startsWith("bfv1.st.")).toBe(true);
      const record = yield* leases.verify(issued.ticket);
      expect(Option.isSome(record)).toBe(true);
      if (Option.isSome(record)) {
        expect(record.value.kind).toBe("stream");
        expect(record.value.authority).toEqual(authority);
        expect(record.value.session.tabId).toBe("tab-1");
        expect(record.value.engineGeneration).toBe("gen-1");
        expect(record.value.hostClientId).toBe("host-a");
        expect(record.value.hostConnectionId).toBe("host-conn-1");
        expect(record.value.expiresAt).toBe(issued.expiresAt);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("mints an input lease whose ticket verifies with the lease binding", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const issued = yield* leases.issueInputLease(issue(sessionAuthority("sess-a")));
      expect(Option.isSome(issued)).toBe(true);
      if (Option.isNone(issued)) return;
      expect(issued.value.leaseId.startsWith("bfli.")).toBe(true);
      expect(issued.value.ticketSeq).toBe(1);
      const record = yield* leases.verify(issued.value.inputTicket);
      expect(Option.isSome(record)).toBe(true);
      if (Option.isSome(record)) {
        expect(record.value.kind).toBe("input");
        expect(record.value.leaseId).toBe(issued.value.leaseId);
        expect(record.value.ticketSeq).toBe(1);
      }
      const lease = yield* leases.resolveLease(issued.value.leaseId);
      expect(Option.isSome(lease)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("renews the same authority's live lease with a higher ticketSeq", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const input = issue(sessionAuthority("sess-a"));
      const first = yield* leases.issueInputLease(input);
      const second = yield* leases.issueInputLease(input);
      if (Option.isNone(first) || Option.isNone(second)) {
        throw new Error("expected both mints to succeed");
      }
      expect(second.value.leaseId).toBe(first.value.leaseId);
      expect(second.value.ticketSeq).toBe(first.value.ticketSeq + 1);
      expect(second.value.inputTicket).not.toBe(first.value.inputTicket);
      // Renewal supersedes the older ticket: it cannot verify — and so can
      // never seize the socket or reset packet replay at the hub.
      expect(Option.isNone(yield* leases.verify(first.value.inputTicket))).toBe(true);
      expect(Option.isSome(yield* leases.verify(second.value.inputTicket))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("distinct extension contexts or generations cannot share a lease", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const base = issue(extensionAuthority("sess-a"));
      const first = yield* leases.issueInputLease(base);
      const otherContext = yield* leases.issueInputLease(
        issue({
          ...extensionAuthority("sess-a"),
          context: { resource: { projectId: "proj-2" } },
        }),
      );
      const otherGeneration = yield* leases.issueInputLease(
        issue({
          ...extensionAuthority("sess-a"),
          callerGenerations: [
            { pluginId: "ext-leaf", contentHash: "hash-1", installationGeneration: 2 },
          ],
        }),
      );
      if (Option.isNone(first) || Option.isNone(otherContext) || Option.isNone(otherGeneration)) {
        throw new Error("expected all mints to succeed");
      }
      // Same session but a different authority shape is a different holder.
      expect(otherContext.value.leaseId).not.toBe(first.value.leaseId);
      expect(otherGeneration.value.leaseId).not.toBe(first.value.leaseId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("explicit renewal requires owning the named lease", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const owner = issue(sessionAuthority("sess-a"));
      const first = yield* leases.issueInputLease(owner);
      if (Option.isNone(first)) throw new Error("expected mint to succeed");

      const renewed = yield* leases.issueInputLease({
        ...owner,
        leaseId: first.value.leaseId,
      });
      expect(Option.isSome(renewed)).toBe(true);
      if (Option.isSome(renewed)) {
        expect(renewed.value.leaseId).toBe(first.value.leaseId);
        expect(renewed.value.ticketSeq).toBe(2);
      }

      // A different authority naming the same lease is refused.
      const stolen = yield* leases.issueInputLease({
        ...issue(sessionAuthority("sess-b")),
        leaseId: first.value.leaseId,
      });
      expect(Option.isNone(stolen)).toBe(true);

      // Same authority, different connection id — a different holder.
      const otherConnection = yield* leases.issueInputLease({
        ...issue(sessionAuthority("sess-a", "conn-2")),
        leaseId: first.value.leaseId,
      });
      expect(Option.isNone(otherConnection)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a different authority gets its own lease; the first stays live", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const first = yield* leases.issueInputLease(issue(sessionAuthority("sess-a")));
      const second = yield* leases.issueInputLease(issue(sessionAuthority("sess-b")));
      if (Option.isNone(first) || Option.isNone(second)) {
        throw new Error("expected both mints to succeed");
      }
      expect(second.value.leaseId).not.toBe(first.value.leaseId);
      expect(Option.isSome(yield* leases.verify(first.value.inputTicket))).toBe(true);
      expect(Option.isSome(yield* leases.resolveLease(first.value.leaseId))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("connections sharing a session cannot renew each other's lease", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const first = yield* leases.issueInputLease(issue(sessionAuthority("sess-a", "conn-1")));
      const second = yield* leases.issueInputLease(issue(sessionAuthority("sess-a", "conn-2")));
      if (Option.isNone(first) || Option.isNone(second)) {
        throw new Error("expected both mints to succeed");
      }
      expect(second.value.leaseId).not.toBe(first.value.leaseId);
      expect(Option.isSome(yield* leases.resolveLease(first.value.leaseId))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("revokeLease retires the lease and its tickets, idempotently", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const issued = yield* leases.issueInputLease(issue(sessionAuthority("sess-a")));
      if (Option.isNone(issued)) throw new Error("expected mint to succeed");
      expect(yield* leases.revokeLease(issued.value.leaseId)).toBe(true);
      expect(Option.isNone(yield* leases.verify(issued.value.inputTicket))).toBe(true);
      expect(Option.isNone(yield* leases.resolveLease(issued.value.leaseId))).toBe(true);
      // A revoked lease cannot be revived by renewal.
      const revived = yield* leases.issueInputLease({
        ...issue(sessionAuthority("sess-a")),
        leaseId: issued.value.leaseId,
      });
      expect(Option.isNone(revived)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("expired tickets stop verifying at the TTL floor", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const input = issue(sessionAuthority("sess-a"));
      const stream = Option.getOrThrow(yield* leases.issueStreamTicket(input));
      const input_ = yield* leases.issueInputLease(input);
      if (Option.isNone(input_)) throw new Error("expected mint to succeed");
      yield* TestClock.adjust(BROWSER_FRAME_TICKET_TTL_MS + 1);
      expect(Option.isNone(yield* leases.verify(stream.ticket))).toBe(true);
      expect(Option.isNone(yield* leases.verify(input_.value.inputTicket))).toBe(true);
      expect(Option.isNone(yield* leases.resolveLease(input_.value.leaseId))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("authorityExpiresAt caps a credential's life below the TTL", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const now = yield* Clock.currentTimeMillis;
      const cap = now + 1_000;
      const issued = Option.getOrThrow(
        yield* leases.issueStreamTicket({
          ...issue(sessionAuthority("sess-a")),
          authorityExpiresAt: cap,
        }),
      );
      expect(issued.expiresAt).toBe(cap);
      yield* TestClock.adjust(1_001);
      expect(Option.isNone(yield* leases.verify(issued.ticket))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("revokeSession sweeps session and extension authorities riding on it", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const sessionTicket = Option.getOrThrow(
        yield* leases.issueStreamTicket(issue(sessionAuthority("sess-a"))),
      );
      const extensionTicket = Option.getOrThrow(
        yield* leases.issueStreamTicket(issue(extensionAuthority("sess-a"))),
      );
      const unaffected = Option.getOrThrow(
        yield* leases.issueStreamTicket(issue(sessionAuthority("sess-b"))),
      );

      yield* leases.revokeSession(AuthSessionId.make("sess-a"));

      expect(Option.isNone(yield* leases.verify(sessionTicket.ticket))).toBe(true);
      expect(Option.isNone(yield* leases.verify(extensionTicket.ticket))).toBe(true);
      expect(Option.isSome(yield* leases.verify(unaffected.ticket))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("invalidations emit lease, authority, and session events", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const seen = yield* Stream.take(leases.invalidations, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      // Let the child subscribe before events are published — a sliding
      // pubsub drops messages with no subscriber.
      yield* Effect.yieldNow;
      const authority = sessionAuthority("sess-a");
      const issued = yield* leases.issueInputLease(issue(authority));
      // A live stream ticket for the same authority makes the session sweep
      // emit an authority event in addition to the session event.
      yield* leases.issueStreamTicket(issue(authority));
      if (Option.isNone(issued)) throw new Error("expected mint to succeed");
      yield* leases.revokeLease(issued.value.leaseId);
      yield* leases.revokeSession(AuthSessionId.make("sess-a"));
      const events = yield* Fiber.join(seen);
      const kinds = [...events].map((event) => event.type);
      expect(kinds).toContain("lease");
      expect(kinds).toContain("authority");
      expect(kinds).toContain("session");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sweep collects expired records and reports the count", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const input = issue(sessionAuthority("sess-a"));
      yield* leases.issueStreamTicket(input);
      yield* leases.issueInputLease(input);
      yield* TestClock.adjust(BROWSER_FRAME_TICKET_TTL_MS + 1);
      const collected = yield* leases.sweep();
      // ticket + lease + input ticket = 3 records.
      expect(collected).toBe(3);
      const snapshot = yield* leases.records;
      expect(snapshot.tickets).toHaveLength(0);
      expect(snapshot.leases).toHaveLength(0);
    }).pipe(Effect.provide(SlowSweepLayer)),
  );

  it.effect("held surface claims register, expire, and revoke with their authority", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const now = yield* Clock.currentTimeMillis;
      const claim = {
        token: "tok-a",
        authority: extensionAuthority("sess-a"),
        session,
        allowedCommands: ["attach", "present"],
        expiresAt: now + 60_000,
      };
      yield* leases.recordHeldSurfaceClaim(claim);
      expect(Option.isSome(yield* leases.heldSurfaceClaim("tok-a"))).toBe(true);

      // revokeWhere sweeps held claims alongside tickets and leases — a
      // catalogue sweep must not leave a mintable token behind.
      yield* leases.revokeWhere((record) => record.authority.kind === "extension");
      expect(Option.isNone(yield* leases.heldSurfaceClaim("tok-a"))).toBe(true);

      yield* leases.recordHeldSurfaceClaim({ ...claim, token: "tok-b" });
      yield* TestClock.adjust(61_000);
      expect(Option.isNone(yield* leases.heldSurfaceClaim("tok-b"))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a revoked connection can never mint again — tickets, leases, claims", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const sessionAuth = sessionAuthority("sess-a", "conn-1");
      const extensionAuth = { ...extensionAuthority("sess-a"), rootConnectionId: "conn-1" };
      // Live records under conn-1 die at revoke, as before.
      yield* leases.issueStreamTicket(issue(sessionAuth));
      yield* leases.revokeConnection("conn-1");
      // Every mint path now refuses the dead connection — the in-flight hole.
      expect(Option.isNone(yield* leases.issueStreamTicket(issue(sessionAuth)))).toBe(true);
      expect(Option.isNone(yield* leases.issueInputLease(issue(sessionAuth)))).toBe(true);
      expect(Option.isNone(yield* leases.issueStreamTicket(issue(extensionAuth)))).toBe(true);
      expect(Option.isNone(yield* leases.issueInputLease(issue(extensionAuth)))).toBe(true);
      expect(
        yield* leases.recordHeldSurfaceClaim({
          token: "tok-dead",
          authority: extensionAuth,
          session,
          allowedCommands: ["attach"],
          expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
        }),
      ).toBe(false);
      // A different live connection mints normally.
      expect(
        Option.isSome(yield* leases.issueStreamTicket(issue(sessionAuthority("sess-a", "conn-2")))),
      ).toBe(true);
      expect(
        Option.isSome(
          yield* leases.issueInputLease(
            issue({ ...extensionAuthority("sess-a"), rootConnectionId: "conn-2" }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a suspended mint's retained dead-marker survives cap eviction", () =>
    Effect.gen(function* () {
      const leases = yield* BrowserFrameLeases;
      const authority = sessionAuthority("sess-a", "conn-doomed");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const outcome =
        yield* Deferred.make<
          Option.Option<{ readonly ticket: string; readonly expiresAt: number }>
        >();
      // The mint suspends inside withRetainedConnection — the window where a
      // real provider's async work would run — while the connection is
      // revoked and enough later revocations land to fill the marker cap.
      yield* leases
        .withRetainedConnection(
          "conn-doomed",
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.andThen(leases.issueStreamTicket(issue(authority))),
          ),
        )
        .pipe(
          Effect.flatMap((result) => Deferred.succeed(outcome, result)),
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      yield* leases.revokeConnection("conn-doomed");
      for (let i = 0; i < 4104; i += 1) {
        yield* leases.revokeConnection(`conn-flood-${i}`);
      }
      yield* Deferred.succeed(resume, undefined);
      // The marker the pending mint still references was never evicted — the
      // mint resumes into the dead-connection fence and mints nothing.
      expect(Option.isNone(yield* Deferred.await(outcome))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});
