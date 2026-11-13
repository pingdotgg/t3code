import {
  ServerSelfUpdateError,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AsyncResult,
  Atom,
  AtomRegistry,
} from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  createServerEnvironmentAtoms,
  serverUpdateStateAtom,
  matchesServerUpdateReadyEvent,
} from "./server.ts";
import {
  CONFIG,
  TARGET,
  session,
} from "./server.helpers2.testkit.ts";

describe("accepted server update recovery", () => {
  it.effect.each([
    { loss: "interrupt", resumes: true },
    { loss: "socket", resumes: true },
    { loss: "server_error", resumes: false },
    { loss: "no_progress", resumes: false },
    { loss: "cancel", resumes: false },
    { loss: "socket", method: "respawn", resumes: true },
    { loss: "socket", method: "desktop-managed", resumes: false },
  ] as const)("handles $loss with $method and recovery=$resumes", (scenario) =>
    Effect.gen(function* () {
      const { loss, resumes } = scenario;
      const method = "method" in scenario ? scenario.method : "boot-service";
      const observing = yield* Deferred.make<void>();
      const cancelFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const oldReadyObserved = yield* Deferred.make<void>();
      const readyEvents =
        yield* Queue.unbounded<Parameters<typeof matchesServerUpdateReadyEvent>[1]>();
      const config = {
        ...CONFIG,
        environment: {
          ...CONFIG.environment,
          serverVersion: "0.0.30",
          capabilities: { serverSelfUpdate: method, serverSelfUpdateProgress: true },
        },
      } as ServerConfig;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.never,
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(readyEvents)),
            Stream.tap((event) =>
              event.payload.environment.serverVersion === "0.0.30"
                ? Deferred.succeed(oldReadyObserved, undefined)
                : Effect.void,
            ),
          ),
        [WS_METHODS.serverUpdateServerWithProgress]: () =>
          (loss === "no_progress"
            ? Stream.empty
            : Stream.make({ type: "progress" as const, stage: "downloading" as const })
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                loss === "cancel"
                  ? Effect.fiber.pipe(
                      Effect.flatMap((fiber) => Deferred.succeed(cancelFiber, fiber)),
                      Effect.andThen(Effect.never),
                    )
                  : loss === "interrupt"
                    ? Effect.interrupt
                    : Effect.fail(
                        loss === "server_error"
                          ? new ServerSelfUpdateError({
                              reason: "Archive verification failed.",
                            })
                          : new RpcClientError.RpcClientError({
                              reason: new Socket.SocketCloseError({ code: 1006 }),
                            }),
                      ),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
        _id,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        runStream,
        followStream: runStream,
        stateChanges: () => Stream.never,
        retryNow: () => Effect.void,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Layer.succeed(RpcPermissionGuard, { authorize: () => Effect.void }),
          Layer.succeed(Persistence.EnvironmentCacheStore, {
            loadServerConfig: () => Effect.succeedNone,
          } as unknown as Persistence.EnvironmentCacheStore["Service"]),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(config),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
        Effect.sync(() => value.dispose()),
      );
      const pending = atoms.updateServer.run(registry, {
        environmentId: TARGET.environmentId,
        input: { targetVersion: "0.0.31" },
      });
      if (loss === "cancel") {
        yield* Fiber.interrupt(yield* Deferred.await(cancelFiber));
        const cancelled = yield* Effect.promise(() => pending);
        expect(cancelled._tag).toBe("Failure");
        if (cancelled._tag === "Failure")
          expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true);
        expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toEqual({
          status: "idle",
        });
        expect(yield* Deferred.isDone(observing)).toBe(false);
        return;
      }
      const first = yield* Effect.raceFirst(
        Effect.promise(() => pending).pipe(Effect.as("settled")),
        Deferred.await(observing).pipe(Effect.as("observing")),
      );
      if (!resumes) {
        expect(first).toBe("settled");
        expect(AsyncResult.isFailure(yield* Effect.promise(() => pending))).toBe(true);
        expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
          status: "failed",
        });
        return;
      }
      expect(first).toBe("observing");
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
      });
      const ready = (serverVersion: string) =>
        ({
          version: 1,
          sequence: 1,
          type: "ready",
          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      yield* Queue.offer(readyEvents, ready("0.0.30"));
      yield* Deferred.await(oldReadyObserved);
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
        status: "running",
      });
      yield* Queue.offer(readyEvents, ready("0.0.31"));
      expect(AsyncResult.isSuccess(yield* Effect.promise(() => pending))).toBe(true);
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toEqual({
        status: "idle",
      });
    }).pipe(Effect.scoped),
  );
});
