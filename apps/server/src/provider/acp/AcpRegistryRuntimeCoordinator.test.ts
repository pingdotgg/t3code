import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "./AcpRegistryProbe.ts";
import { AcpRegistryRuntimeCoordinator } from "./AcpRegistryRuntimeCoordinator.ts";

describe("AcpRegistryRuntimeCoordinator", () => {
  it.effect("suppresses a background probe while foreground startup is active", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("interrupts an active background probe when foreground startup begins", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("serializes native session mutations across callers", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("replays and replaces late command advertisements per provider instance", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("replays and replaces live configuration per provider instance", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");
      const firstSeen = yield* Deferred.make<void>();
      const replacementSeen = yield* Deferred.make<void>();
      const received: Array<AcpRegistryLiveConfiguration> = [];
      const first = {
        models: [{ id: "sonnet", name: "Sonnet", description: null }],
        currentModelId: "sonnet",
        configOptions: [],
      } satisfies AcpRegistryLiveConfiguration;
      const replacement = {
        models: [{ id: "opus", name: "Opus", description: null }],
        currentModelId: "opus",
        configOptions: [],
      } satisfies AcpRegistryLiveConfiguration;

      yield* coordinator.publishLiveConfiguration(instanceId, first);
      const consumer = yield* coordinator
        .watchLiveConfiguration(instanceId, (configuration) =>
          Effect.gen(function* () {
            received.push(configuration);
            yield* received.length === 1
              ? Deferred.succeed(firstSeen, undefined)
              : Deferred.succeed(replacementSeen, undefined);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSeen);
      yield* coordinator.publishLiveConfiguration(instanceId, replacement);
      yield* Deferred.await(replacementSeen);
      yield* Fiber.interrupt(consumer);

      expect(received).toEqual([first, replacement]);
      expect(yield* coordinator.getLiveConfiguration(instanceId)).toEqual(Option.some(replacement));
      yield* coordinator.clearLiveConfiguration(instanceId);
      expect(Option.isNone(yield* coordinator.getLiveConfiguration(instanceId))).toBe(true);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("requires matching user consent before accepting URL authentication", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("expires stale URL authentication actions without accepting them", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_expired");
      const actionSeen = yield* Deferred.make<void>();
      const consumer = yield* coordinator
        .watchUrlAuthAction(instanceId, (current) =>
          current === null
            ? Effect.void
            : Deferred.succeed(actionSeen, undefined).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkChild);
      const request = yield* coordinator
        .requestUrlAuthentication(instanceId, {
          elicitationId: "expired-login",
          url: "https://accounts.example.com/login",
          message: "Continue in your browser",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(actionSeen);
      yield* TestClock.adjust("10 minutes");

      expect(yield* Fiber.join(request)).toBe(false);
      expect(
        yield* coordinator.acceptUrlAuthentication({
          instanceId,
          elicitationId: "expired-login",
        }),
      ).toBe(false);
      expect(Option.isNone(yield* coordinator.getUrlAuthAction(instanceId))).toBe(true);
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("publishes a replacement URL action before retiring the previous request", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );

  it.effect("clears a published URL action when its request is interrupted", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
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
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );
});
