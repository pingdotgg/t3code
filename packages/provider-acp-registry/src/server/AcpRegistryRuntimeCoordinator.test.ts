import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { AcpRegistryAvailableCommands } from "./probe.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";

describe("AcpRegistryRuntimeCoordinator", () => {
  it.effect("suppresses a background probe while foreground startup is active", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const foregroundStarted = yield* Deferred.make<void>();
      const releaseForeground = yield* Deferred.make<void>();
      const foreground = yield* coordinator
        .withForegroundStartup(
          "kilo",
          Deferred.succeed(foregroundStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseForeground)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(foregroundStarted);

      const probed = yield* coordinator.runBackgroundProbe("kilo", Effect.succeed("unexpected"));
      expect(Option.isNone(probed)).toBe(true);

      yield* Deferred.succeed(releaseForeground, undefined);
      yield* Fiber.join(foreground);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("interrupts an active background probe when foreground startup begins", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const probeStarted = yield* Deferred.make<void>();
      const probeFinalized = yield* Deferred.make<void>();
      const releaseForeground = yield* Deferred.make<void>();
      const probe = yield* coordinator
        .runBackgroundProbe(
          "kilo",
          Deferred.succeed(probeStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(probeFinalized, undefined).pipe(Effect.ignore)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(probeStarted);

      const foreground = yield* coordinator
        .withForegroundStartup("kilo", Deferred.await(releaseForeground))
        .pipe(Effect.forkChild);
      expect(Option.isNone(yield* Fiber.join(probe))).toBe(true);
      yield* Deferred.await(probeFinalized);

      yield* Deferred.succeed(releaseForeground, undefined);
      yield* Fiber.join(foreground);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("serializes native session mutations across callers", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const first = yield* coordinator
        .withSessionMutation(
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* coordinator
        .withSessionMutation(Deferred.succeed(secondEntered, undefined))
        .pipe(Effect.forkChild);
      expect(yield* Deferred.poll(secondEntered)).toEqual(Option.none());

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(Option.isSome(yield* Deferred.poll(secondEntered))).toBe(true);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("replays and replaces late command advertisements per provider instance", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const codex = ProviderInstanceId.make("acpRegistry_codex");
      const kilo = ProviderInstanceId.make("acpRegistry_kilo");
      const firstSeen = yield* Deferred.make<void>();
      const replacementSeen = yield* Deferred.make<void>();
      const received: Array<AcpRegistryAvailableCommands> = [];

      yield* coordinator.publishAvailableCommands(codex, {
        slashCommands: [{ name: "status" }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      });
      const consumer = yield* coordinator
        .watchAvailableCommands(codex, (commands) =>
          Effect.gen(function* () {
            received.push(commands);
            yield* received.length === 1
              ? Deferred.succeed(firstSeen, undefined)
              : Deferred.succeed(replacementSeen, undefined);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSeen);

      yield* coordinator.publishAvailableCommands(kilo, {
        slashCommands: [{ name: "review" }],
        skills: [],
      });
      yield* coordinator.publishAvailableCommands(codex, { slashCommands: [], skills: [] });
      yield* Deferred.await(replacementSeen);
      yield* Fiber.interrupt(consumer);

      expect(received).toEqual([
        {
          slashCommands: [{ name: "status" }],
          skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
        },
        { slashCommands: [], skills: [] },
      ]);
      expect(yield* coordinator.getAvailableCommands(kilo)).toEqual(
        Option.some({ slashCommands: [{ name: "review" }], skills: [] }),
      );
      yield* coordinator.clearAvailableCommands(codex);
      expect(Option.isNone(yield* coordinator.getAvailableCommands(codex))).toBe(true);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("requires matching user consent before accepting URL authentication", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
      const action = {
        elicitationId: "login-1",
        url: "https://accounts.example.com/login",
        message: "Continue in your browser",
      };
      const actionSeen = yield* Deferred.make<void>();
      const consumer = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current === null
            ? Effect.void
            : Deferred.succeed(actionSeen, undefined).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkChild);
      const request = yield* coordinator
        .requestUrlAuthentication(instanceId, action)
        .pipe(Effect.forkChild);
      yield* Deferred.await(actionSeen);

      expect(yield* coordinator.getUrlAuthAction(instanceId)).toEqual(
        Option.some({
          ...action,
          createdAt: "1970-01-01T00:00:00.000Z",
          expiresAt: "1970-01-01T00:10:00.000Z",
        }),
      );

      expect(
        yield* coordinator.acceptUrlAuthentication({ instanceId, elicitationId: "stale" }),
      ).toBe(false);
      expect(
        yield* coordinator.acceptUrlAuthentication({ instanceId, elicitationId: "login-1" }),
      ).toBe(true);
      expect(yield* Fiber.join(request)).toBe(true);
      expect(Option.isNone(yield* coordinator.getUrlAuthAction(instanceId))).toBe(true);

      // Decouple current-time reads from TestClock sleep so the exact expiry boundary (>=) is
      // tested in both getUrlAuthAction and acceptUrlAuthentication while the request is pending.
      const baseClock = yield* Clock.Clock;
      let clockNowMs = 0;
      const decoupledClock: Clock.Clock = {
        ...baseClock,
        currentTimeMillisUnsafe: () => clockNowMs,
        currentTimeMillis: Effect.sync(() => clockNowMs),
        currentTimeNanosUnsafe: () => BigInt(clockNowMs) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(clockNowMs) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => BigInt(clockNowMs) * 1_000_000n,
        monotonicTimeNanos: Effect.sync(() => BigInt(clockNowMs) * 1_000_000n),
        sleep: (duration) => baseClock.sleep(duration),
      };
      const withDecoupledClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Clock.Clock, decoupledClock));

      // Consent must still succeed 1 ms before expiry while the request is pending.
      const beforeExpirySeen = yield* Deferred.make<void>();
      const expiringWatcher = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current?.elicitationId === "login-before-expiry"
            ? Deferred.succeed(beforeExpirySeen, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      const beforeExpiryRequest = yield* withDecoupledClock(
        coordinator.requestUrlAuthentication(instanceId, {
          ...action,
          elicitationId: "login-before-expiry",
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(beforeExpirySeen);
      clockNowMs = 10 * 60 * 1_000 - 1;
      expect(
        Option.isSome(yield* withDecoupledClock(coordinator.getUrlAuthAction(instanceId))),
      ).toBe(true);
      expect(
        yield* withDecoupledClock(
          coordinator.acceptUrlAuthentication({
            instanceId,
            elicitationId: "login-before-expiry",
          }),
        ),
      ).toBe(true);
      expect(yield* Fiber.join(beforeExpiryRequest)).toBe(true);
      yield* Fiber.interrupt(expiringWatcher);

      // Consent must be rejected at the exact expiry millisecond while the timeout has not fired.
      clockNowMs = 0;
      const exactExpirySeen = yield* Deferred.make<void>();
      const exactExpiryWatcher = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current?.elicitationId === "login-expiring"
            ? Deferred.succeed(exactExpirySeen, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      const expiringRequest = yield* withDecoupledClock(
        coordinator.requestUrlAuthentication(instanceId, {
          ...action,
          elicitationId: "login-expiring",
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(exactExpirySeen);
      clockNowMs = 10 * 60 * 1_000;
      expect(expiringRequest.pollUnsafe()).toBeUndefined();
      expect(
        Option.isNone(yield* withDecoupledClock(coordinator.getUrlAuthAction(instanceId))),
      ).toBe(true);
      expect(expiringRequest.pollUnsafe()).toBeUndefined();
      expect(
        yield* withDecoupledClock(
          coordinator.acceptUrlAuthentication({ instanceId, elicitationId: "login-expiring" }),
        ),
      ).toBe(false);
      expect(yield* Fiber.join(expiringRequest)).toBe(false);
      yield* Fiber.interrupt(exactExpiryWatcher);

      // An unaccepted request also expires cleanly when the timeout fires.
      const timeoutSeen = yield* Deferred.make<void>();
      const timeoutWatcher = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current?.elicitationId === "login-timeout"
            ? Deferred.succeed(timeoutSeen, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      const timeoutRequest = yield* coordinator
        .requestUrlAuthentication(instanceId, {
          ...action,
          elicitationId: "login-timeout",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(timeoutSeen);
      yield* TestClock.adjust("10 minutes");
      expect(yield* Fiber.join(timeoutRequest)).toBe(false);
      expect(Option.isNone(yield* coordinator.getUrlAuthAction(instanceId))).toBe(true);
      yield* Fiber.interrupt(timeoutWatcher);
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("publishes a replacement URL action before retiring the previous request", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_replacement");
      const received: Array<string | null> = [];
      const firstSeen = yield* Deferred.make<void>();
      const replacementSeen = yield* Deferred.make<void>();
      const consumer = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          Effect.sync(() => {
            received.push(current?.elicitationId ?? null);
          }).pipe(
            Effect.andThen(
              current?.elicitationId === "login-1"
                ? Deferred.succeed(firstSeen, undefined).pipe(Effect.asVoid)
                : current?.elicitationId === "login-2"
                  ? Deferred.succeed(replacementSeen, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            ),
          ),
        )
        .pipe(Effect.forkChild);
      const first = yield* coordinator
        .requestUrlAuthentication(instanceId, {
          elicitationId: "login-1",
          url: "https://accounts.example.com/first",
          message: "Continue with the first login",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSeen);
      const replacement = yield* coordinator
        .requestUrlAuthentication(instanceId, {
          elicitationId: "login-2",
          url: "https://accounts.example.com/replacement",
          message: "Continue with the replacement login",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(replacementSeen);

      expect(yield* Fiber.join(first)).toBe(false);
      expect(
        (yield* coordinator.getUrlAuthAction(instanceId)).pipe(Option.getOrThrow),
      ).toMatchObject({ elicitationId: "login-2" });
      expect(received.slice(0, 2)).toEqual(["login-1", "login-2"]);
      expect(
        yield* coordinator.acceptUrlAuthentication({ instanceId, elicitationId: "login-2" }),
      ).toBe(true);
      expect(yield* Fiber.join(replacement)).toBe(true);
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("clears a published URL action when its request is interrupted", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_interrupted");
      const actionSeen = yield* Deferred.make<void>();
      const cleared = yield* Deferred.make<void>();
      const consumer = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current === null
            ? Deferred.succeed(cleared, undefined).pipe(Effect.asVoid)
            : Deferred.succeed(actionSeen, undefined).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkChild);
      const request = yield* coordinator
        .requestUrlAuthentication(instanceId, {
          elicitationId: "interrupted-login",
          url: "https://accounts.example.com/interrupted",
          message: "Continue with login",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(actionSeen);

      yield* Fiber.interrupt(request);
      yield* Deferred.await(cleared);
      expect(Option.isNone(yield* coordinator.getUrlAuthAction(instanceId))).toBe(true);
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect(
    "isolates per-runtime state, evaluates chained clear watermarks, and drops disposed instances",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const instanceId = ProviderInstanceId.make("acpRegistry_runtime_scoped");
        const metas: Array<{
          readonly label: string;
          readonly meta: AcpRegistryRuntimeCoordinator.AcpRegistryLiveUpdateMeta;
        }> = [];
        const expectedCount = { target: 0, gate: yield* Deferred.make<void>() };
        const watcher = yield* coordinator
          .watchAvailableCommands(instanceId, (commands, meta) =>
            Effect.gen(function* () {
              metas.push({ label: commands.slashCommands[0]?.name ?? "empty", meta });
              if (metas.length >= expectedCount.target) {
                yield* Deferred.succeed(expectedCount.gate, undefined);
              }
            }),
          )
          .pipe(Effect.forkChild);

        const publishAndWait = (name: string, runtimeIdentity?: string) =>
          Effect.gen(function* () {
            expectedCount.target = metas.length + 1;
            expectedCount.gate = yield* Deferred.make<void>();
            yield* coordinator.publishAvailableCommands(
              instanceId,
              { slashCommands: [{ name }], skills: [] },
              runtimeIdentity,
            );
            yield* Deferred.await(expectedCount.gate);
            return metas[metas.length - 1]!.meta;
          });

        // 1. Late update from A must not evict B's stored entry.
        const metaA = yield* publishAndWait("cmd-a", "runtime-a");
        const metaB = yield* publishAndWait("cmd-b", "runtime-b");
        const metaUntagged = yield* publishAndWait("cmd-untagged");
        const metaLateA = yield* publishAndWait("cmd-a-late", "runtime-a");
        expect(
          yield* coordinator.getAvailableCommands(instanceId, {
            runtimeIdentity: "runtime-b",
            requireMatchingRuntimeIdentity: true,
          }),
        ).toEqual(Option.some({ slashCommands: [{ name: "cmd-b" }], skills: [] }));
        expect(yield* metaA.isCurrent).toBe(true);
        expect(yield* metaB.isCurrent).toBe(true);
        expect(yield* metaUntagged.isCurrent).toBe(true);
        expect(yield* metaLateA.isCurrent).toBe(true);

        // 2. Chained preserve clears (preserve B -> preserve C -> preserve B) keep only matching entries current.
        yield* coordinator.clearAvailableCommands(instanceId, {
          preserveRuntimeIdentity: "runtime-b",
        });
        expect(yield* metaA.isCurrent).toBe(false);
        expect(yield* metaLateA.isCurrent).toBe(false);
        expect(yield* metaUntagged.isCurrent).toBe(false);
        expect(yield* metaB.isCurrent).toBe(true);
        expect(
          yield* coordinator.getAvailableCommands(instanceId, {
            runtimeIdentity: "runtime-a",
            requireMatchingRuntimeIdentity: true,
          }),
        ).toEqual(Option.none());
        expect(yield* coordinator.getAvailableCommands(instanceId)).toEqual(
          Option.some({ slashCommands: [{ name: "cmd-b" }], skills: [] }),
        );

        // Even after another runtime publishes later, untagged get prefers preservedRuntimeIdentity.
        const metaC = yield* publishAndWait("cmd-c", "runtime-c");
        expect(yield* coordinator.getAvailableCommands(instanceId)).toEqual(
          Option.some({ slashCommands: [{ name: "cmd-b" }], skills: [] }),
        );
        yield* coordinator.clearAvailableCommands(instanceId, {
          preserveRuntimeIdentity: "runtime-c",
        });
        expect(yield* metaB.isCurrent).toBe(false);
        expect(yield* metaC.isCurrent).toBe(true);

        // Returning to preserve B after preserve C must NOT resurrect the older pre-C metaB.
        const metaB2 = yield* publishAndWait("cmd-b-2", "runtime-b");
        yield* coordinator.clearAvailableCommands(instanceId, {
          preserveRuntimeIdentity: "runtime-b",
        });
        expect(yield* metaB.isCurrent).toBe(false);
        expect(yield* metaC.isCurrent).toBe(false);
        expect(yield* metaB2.isCurrent).toBe(true);

        // 3. Full clear invalidates everything published before it; subsequent publications stay current.
        yield* coordinator.clearAvailableCommands(instanceId);
        expect(yield* metaB2.isCurrent).toBe(false);
        expect(Option.isNone(yield* coordinator.getAvailableCommands(instanceId))).toBe(true);

        const metaAfterFullClear = yield* publishAndWait("cmd-fresh", "runtime-b");
        expect(yield* metaAfterFullClear.isCurrent).toBe(true);

        // 4. Disposing an instance drops its state and keeps pre-disposal updates permanently stale
        // even after the same instance ID is reused for new publications.
        yield* coordinator.clearAvailableCommands(instanceId, { dispose: true });
        expect(yield* metaAfterFullClear.isCurrent).toBe(false);
        expect(Option.isNone(yield* coordinator.getAvailableCommands(instanceId))).toBe(true);

        const metaAfterReuse = yield* publishAndWait("cmd-reused", "runtime-b");
        expect(yield* metaAfterReuse.isCurrent).toBe(true);
        expect(yield* metaAfterFullClear.isCurrent).toBe(false);

        // 5. A newly subscribed watcher replays retained per-runtime entries in ascending revision
        // order and delivers subsequent live publications without replaying older revisions.
        yield* coordinator.publishAvailableCommands(
          instanceId,
          { slashCommands: [{ name: "cmd-reused-c" }], skills: [] },
          "runtime-c",
        );
        const replayedNames: Array<string> = [];
        const initialReplayDone = yield* Deferred.make<void>();
        const replayDone = yield* Deferred.make<void>();
        const secondWatcher = yield* coordinator
          .watchAvailableCommands(instanceId, (commands) =>
            Effect.gen(function* () {
              replayedNames.push(commands.slashCommands[0]?.name ?? "empty");
              if (replayedNames.length === 2) {
                yield* Deferred.succeed(initialReplayDone, undefined);
              }
              if (replayedNames.length >= 3) {
                yield* Deferred.succeed(replayDone, undefined);
              }
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(initialReplayDone);
        yield* coordinator.publishAvailableCommands(
          instanceId,
          { slashCommands: [{ name: "cmd-after-watch" }], skills: [] },
          "runtime-b",
        );
        yield* Deferred.await(replayDone);
        expect(replayedNames).toEqual(["cmd-reused", "cmd-reused-c", "cmd-after-watch"]);
        yield* Fiber.interrupt(secondWatcher);

        // 6. Concurrent publications for the same runtime are serialized so watchers always finish
        // on the exact latest committed state returned by get().
        const concurrentCount = 12;
        const concurrentNames: Array<string> = [];
        const concurrentReady = yield* Deferred.make<void>();
        const concurrentDone = yield* Deferred.make<void>();
        const concurrentWatcher = yield* coordinator
          .watchAvailableCommands(instanceId, (commands) =>
            Effect.gen(function* () {
              const name = commands.slashCommands[0]?.name ?? "empty";
              if (name === "cmd-after-watch") {
                yield* Deferred.succeed(concurrentReady, undefined);
              } else if (name.startsWith("concurrent-")) {
                concurrentNames.push(name);
                if (concurrentNames.length >= concurrentCount) {
                  yield* Deferred.succeed(concurrentDone, undefined);
                }
              }
            }),
          )
          .pipe(Effect.forkChild);
        // Wait for concurrentWatcher itself to finish its initial replay before firing the batch.
        yield* Deferred.await(concurrentReady);
        yield* Effect.all(
          Array.from({ length: concurrentCount }, (_, index) =>
            coordinator.publishAvailableCommands(
              instanceId,
              { slashCommands: [{ name: `concurrent-${index}` }], skills: [] },
              "runtime-b",
            ),
          ),
          { concurrency: "unbounded", discard: true },
        );
        yield* Deferred.await(concurrentDone);
        const committedLatest = Option.getOrThrow(
          yield* coordinator.getAvailableCommands(instanceId, {
            runtimeIdentity: "runtime-b",
            requireMatchingRuntimeIdentity: true,
          }),
        );
        expect(concurrentNames[concurrentNames.length - 1]).toBe(
          committedLatest.slashCommands[0]?.name,
        );
        yield* Fiber.interrupt(concurrentWatcher);
        yield* Fiber.interrupt(watcher);
      }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );
});
