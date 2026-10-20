import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as EnvironmentSupervisor from "./supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  executePeerEnvironmentOperation,
  peerEnvironmentStatus,
  runPeerEnvironmentHost,
} from "./peerHost.ts";
import * as EnvironmentRegistry from "./registry.ts";

const macbook = EnvironmentId.make("environment-macbook");
const r2d2 = EnvironmentId.make("environment-r2d2");
const connected: SupervisorConnectionState = { ...AVAILABLE_CONNECTION_STATE, phase: "connected" };
const blocked = (reason: ConnectionBlockedError["reason"]): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  phase: "blocked",
  lastFailure: new ConnectionBlockedError({ reason, detail: "blocked" }),
});

const entry = (environmentId: EnvironmentId, label: string): ConnectionCatalogEntry => ({
  target: new BearerConnectionTarget({ environmentId, label, connectionId: `bearer:${label}` }),
  profile: { _tag: "None" } as never,
  enabled: true,
});

/** A registry holding both machines, where r2d2 is in `state` and requests must not be sent. */
const run = (
  state: SupervisorConnectionState,
  operation: Parameters<typeof executePeerEnvironmentOperation>[0]["operation"],
) =>
  Effect.gen(function* () {
    const entries = yield* SubscriptionRef.make(
      new Map([
        [macbook, entry(macbook, "MacBook")],
        [r2d2, entry(r2d2, "r2d2")],
      ]),
    );
    return yield* executePeerEnvironmentOperation({
      hostEnvironmentId: macbook,
      operation,
      timeoutMs: 1_000,
    }).pipe(
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, {
        entries,
        state: () => Effect.succeed(state),
        run: () => Effect.die("a request reached an environment that is not connected"),
      } as never),
    );
  });

describe("peer environment host", () => {
  it("reports how this app's connection looks to an agent", () => {
    expect(peerEnvironmentStatus({}, connected)).toBe("connected");
    expect(peerEnvironmentStatus({}, AVAILABLE_CONNECTION_STATE)).toBe("offline");
    expect(peerEnvironmentStatus({}, blocked("authentication"))).toBe("unauthorized");
    expect(peerEnvironmentStatus({}, blocked("unsupported"))).toBe("incompatible");
    expect(
      peerEnvironmentStatus({ unsupportedReason: "needs an update" }, AVAILABLE_CONNECTION_STATE),
    ).toBe("incompatible");
  });

  it.effect("never lists the requesting environment as its own peer", () =>
    Effect.gen(function* () {
      expect(yield* run(connected, { operation: "list" })).toEqual({
        operation: "list",
        environments: [{ environmentId: r2d2, label: "r2d2", status: "connected" }],
      });
    }),
  );

  it.effect("refuses to route a request back to the environment that asked", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(connected, { operation: "catalog", environmentId: macbook }),
      );
      expect(error.code).toBe("environment_not_connected");
    }),
  );

  it.effect("names why a target cannot be reached without sending it anything", () =>
    Effect.gen(function* () {
      const cases = [
        [AVAILABLE_CONNECTION_STATE, "environment_offline"],
        [blocked("permission"), "environment_unauthorized"],
        [blocked("unsupported"), "environment_incompatible"],
      ] as const;
      for (const [state, code] of cases) {
        const error = yield* Effect.flip(run(state, { operation: "catalog", environmentId: r2d2 }));
        expect(error.code).toBe(code);
        expect(error.message).toContain("r2d2");
      }
    }),
  );
});

it.effect("re-registers a peer carrier after a failed stream without a registry change", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const first = yield* Deferred.make<void>();
    const reconnected = yield* Deferred.make<void>();
    const session = {
      initialConfig: Effect.succeed({ environment: { capabilities: { peerEnvironments: true } } }),
      client: {
        [WS_METHODS.peerEnvironmentsConnect]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              attempts += 1;
              if (attempts === 1) {
                yield* Deferred.succeed(first, undefined);
                return Stream.fail("carrier released");
              }
              yield* Deferred.succeed(reconnected, undefined);
              return Stream.never;
            }),
          ),
      },
    } as unknown as RpcSession;
    const sessions = yield* SubscriptionRef.make(Option.some(session));
    const entries = yield* SubscriptionRef.make(new Map([[macbook, entry(macbook, "MacBook")]]));
    const registry = {
      entries,
      followStream: (
        _id: EnvironmentId,
        stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) =>
        stream.pipe(
          Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, {
            session: sessions,
          } as never),
        ),
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
    const running = yield* runPeerEnvironmentHost().pipe(
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.forkChild,
    );
    yield* Deferred.await(first);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(reconnected);
    expect(attempts).toBe(2);
    yield* Fiber.interrupt(running);
  }),
);
