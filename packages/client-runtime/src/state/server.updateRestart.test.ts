import {
  EnvironmentId,
  ProviderDriverKind,
  ServerSelfUpdateError,
  ProviderInstanceId,
  type ProviderInstallState,
  type ProviderSetupInput,
  ServerObservability,
  EnvironmentThemeId,
  UsageLimitSourceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerWelcomeEvent,
  createServerEnvironmentAtoms,
  serverUpdateStateAtom,
  makeEnvironmentServerWelcomeState,
  makeEnvironmentServerConfigState,
  isLegacyUpdateHandoffLoss,
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
  matchesServerUpdateReadyEvent,
  matchesServerUpdateResumeEvent,
  nudgeReconnectDuringUpdateRestart,
  resolveServerConfigValue,
  resolveServerWelcomeState,
  resolveServerUpdateProgressResult,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
  waitForNextEnvironmentReconnect,
  waitForDesktopUpdateTarget,
  runDesktopCommitWithReconnectObserver,
} from "./server.ts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";

describe("update restart reconnect nudges", () => {
  it.effect("retries a desktop commit that was lost before delivery", () =>
    Effect.gen(function* () {
      const readyEvents =
        yield* Queue.unbounded<Parameters<typeof matchesServerUpdateReadyEvent>[1]>();
      const ready = (serverVersion: string) =>
        ({
          version: 1 as const,
          sequence: 1,
          type: "ready" as const,
          payload: {
            at: "2026-09-01T00:00:00.000Z",
            environment: { serverVersion },
          },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      yield* Queue.offerAll(readyEvents, [ready("0.0.30"), ready("0.0.31")]);
      const retries = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });

      const result = yield* waitForDesktopUpdateTarget(
        "0.0.31",
        Queue.take(readyEvents),
        Ref.update(retries, (count) => count + 1).pipe(Effect.andThen(Effect.fail(disconnect))),
      );

      expect(result.payload.environment.serverVersion).toBe("0.0.31");
      expect(yield* Ref.get(retries)).toBe(1);
    }),
  );
  it.effect("observes a fast reconnect even when the caller awaits it later", () =>
    Effect.gen(function* () {
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      const reconnected = yield* waitForNextEnvironmentReconnect(Stream.fromQueue(states)).pipe(
        Effect.forkChild,
      );
      yield* Queue.offerAll(states, [
        { phase: "connected" },
        { phase: "backoff" },
        { phase: "connected" },
      ]);

      yield* Fiber.join(reconnected);
    }),
  );
  it.effect("arms the retry observer before a commit can disconnect", () =>
    Effect.gen(function* () {
      const allowSubscription = yield* Deferred.make<void>();
      const subscriptionStarted = yield* Deferred.make<void>();
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      const commits = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const stateChanges = Stream.unwrap(
        Deferred.succeed(subscriptionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowSubscription)),
          Effect.as(Stream.fromQueue(states)),
        ),
      );
      const retry = yield* runDesktopCommitWithReconnectObserver(
        stateChanges,
        Ref.update(commits, (count) => count + 1).pipe(
          Effect.andThen(Queue.offerAll(states, [{ phase: "backoff" }, { phase: "connected" }])),
          Effect.andThen(Effect.fail(disconnect)),
        ),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(subscriptionStarted);
      expect(yield* Ref.get(commits)).toBe(0);
      yield* Deferred.succeed(allowSubscription, undefined);
      yield* Queue.offer(states, { phase: "connected" });

      expect(yield* Fiber.join(retry)).toBe(disconnect);
      expect(yield* Ref.get(commits)).toBe(1);
    }),
  );
  it.effect("retries once per backoff entry instead of only the first", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);
      const states = [
        { phase: "backoff" },
        { phase: "connecting" },
        { phase: "backoff" },
        { phase: "backoff" },
      ];

      yield* nudgeReconnectDuringUpdateRestart({
        stateChanges: Stream.fromIterable(states),
        retryNow: Ref.update(retries, (count) => count + 1),
        interval: Duration.zero,
      });

      expect(yield* Ref.get(retries)).toBe(3);
    }),
  );

  it.effect("retries rejected credentials only while the update restart is in progress", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);

      yield* nudgeReconnectDuringUpdateRestart({
        stateChanges: Stream.fromIterable([
          { phase: "blocked", lastFailure: { reason: "permission" } },
          {
            phase: "blocked",
            lastFailure: {
              reason: "authentication",
              detail: "The environment credential is invalid.",
            },
          },
          { phase: "blocked", lastFailure: { reason: "configuration" } },
        ]),
        retryNow: Ref.update(retries, (count) => count + 1),
        interval: Duration.zero,
      });

      expect(yield* Ref.get(retries)).toBe(1);
    }),
  );
});
