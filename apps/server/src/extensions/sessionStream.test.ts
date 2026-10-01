import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  SessionTokenRevokedError,
  type RevalidatedSession,
  type SessionCredentialChange,
} from "../auth/SessionStore.ts";
import { guardExtensionSessionStream } from "./sessionStream.ts";

const fixture = Effect.fn("streamSession.fixture")(function* () {
  const changes = yield* PubSub.unbounded<SessionCredentialChange>();
  const session: RevalidatedSession = {
    sessionId: AuthSessionId.make("session-a"),
    subject: "fixture",
    method: "bearer-access-token",
    scopes: [AuthOrchestrationReadScope],
    expiresAt: DateTime.makeUnsafe(10_000),
  };
  let current = session;
  let removed = false;
  let beforeCheck: Effect.Effect<void> = Effect.void;
  const sessions = {
    watchChanges: () => PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    revalidate: Effect.fn("fixture.revalidate")(function* () {
      yield* beforeCheck;
      if (removed)
        return yield* new SessionTokenRevokedError({
          sessionId: session.sessionId,
          revokedAt: DateTime.makeUnsafe(0),
        });
      return current;
    }),
  };
  return {
    session,
    sessions,
    changes,
    setCurrent(next: RevalidatedSession) {
      current = next;
    },
    onCheck(effect: Effect.Effect<void>) {
      beforeCheck = effect;
    },
    revoke: Effect.gen(function* () {
      removed = true;
      yield* PubSub.publish(changes, { type: "clientRemoved", sessionId: session.sessionId });
    }),
  };
});

it.effect("delivers an authorized stream and closes normally", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const values = yield* guardExtensionSessionStream(
      Stream.make(1, 2),
      f.session,
      f.sessions,
    ).pipe(Stream.runCollect);
    expect(values).toEqual([1, 2]);
  }),
);

it.effect("rejects revoked admission before starting the producer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let opened = false;
    yield* f.revoke;
    const source = Stream.make(1).pipe(
      Stream.onStart(
        Effect.sync(() => {
          opened = true;
        }),
      ),
    );
    const error = yield* guardExtensionSessionStream(source, f.session, f.sessions).pipe(
      Stream.runDrain,
      Effect.flip,
    );
    expect(error._tag).toBe("ExtensionOperationError");
    expect(opened).toBe(false);
  }),
);

it.effect("revocation interrupts a silent pending producer and awaits its cleanup", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const entered = yield* Deferred.make<void>();
    let closed = false;
    const source = Stream.never.pipe(
      Stream.onStart(Deferred.succeed(entered, undefined)),
      Stream.ensuring(
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    const fiber = yield* guardExtensionSessionStream(source, f.session, f.sessions).pipe(
      Stream.runDrain,
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* f.revoke;
    const error = yield* Fiber.join(fiber);
    expect(error._tag).toBe("ExtensionOperationError");
    expect(closed).toBe(true);
  }),
);

it.effect("subscribes before revalidation so removal during admission is not lost", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.onCheck(
      PubSub.publish(f.changes, { type: "clientRemoved", sessionId: f.session.sessionId }).pipe(
        Effect.asVoid,
      ),
    );
    const error = yield* guardExtensionSessionStream(Stream.never, f.session, f.sessions).pipe(
      Stream.runDrain,
      Effect.flip,
    );
    expect(error._tag).toBe("ExtensionOperationError");
  }),
);

it.effect("expiry interrupts a silent stream using the earlier verified token expiry", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const entered = yield* Deferred.make<void>();
    let closed = false;
    const source = Stream.never.pipe(
      Stream.onStart(Deferred.succeed(entered, undefined)),
      Stream.ensuring(
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    const session = { ...f.session, expiresAt: DateTime.makeUnsafe(1000) };
    const fiber = yield* guardExtensionSessionStream(source, session, f.sessions).pipe(
      Stream.runDrain,
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(1000);
    const error = yield* Fiber.join(fiber);
    expect(error._tag).toBe("ExtensionOperationError");
    expect(closed).toBe(true);
  }),
);

it.effect("another session's removal does not interrupt an authorized producer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const source = Stream.fromEffect(
      PubSub.publish(f.changes, {
        type: "clientRemoved",
        sessionId: AuthSessionId.make("session-b"),
      }).pipe(Effect.as(42)),
    );
    const values = yield* guardExtensionSessionStream(source, f.session, f.sessions).pipe(
      Stream.runCollect,
    );
    expect(values).toEqual([42]);
  }),
);

it.effect("suppresses a frame after persisted scope removal", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const source = Stream.fromEffect(
      Effect.sync(() => {
        f.setCurrent({ ...f.session, scopes: [] });
        return 42;
      }),
    );
    const delivered: number[] = [];
    const error = yield* guardExtensionSessionStream(source, f.session, f.sessions).pipe(
      Stream.tap((value) =>
        Effect.sync(() => {
          delivered.push(value);
        }),
      ),
      Stream.runDrain,
      Effect.flip,
    );
    expect(error._tag).toBe("ExtensionOperationError");
    expect(delivered).toEqual([]);
  }),
);

it.effect("persisted scopes cannot widen the originally authenticated token", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const error = yield* guardExtensionSessionStream(
      Stream.make(42),
      { ...f.session, scopes: [] },
      f.sessions,
    ).pipe(Stream.runDrain, Effect.flip);
    expect(error._tag).toBe("ExtensionOperationError");
  }),
);
