import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

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

  it.effect("skips stale live configuration revisions when watching after a revision", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_devin");
      const configFor = (id: string) => ({
        models: [{ id, name: id, description: null }],
        currentModelId: id,
        configOptions: [],
        modelsFromModelSelect: true,
      });

      yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v1"));
      const first = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
      expect(first.revision).toBeGreaterThan(0);

      const received: Array<readonly [string | null, number]> = [];
      const secondSeen = yield* Deferred.make<void>();
      const watcher = yield* coordinator
        .watchLiveConfiguration(
          instanceId,
          (configuration, revision) =>
            Effect.sync(() => {
              received.push([configuration.currentModelId, revision] as const);
            }).pipe(Effect.andThen(Deferred.succeed(secondSeen, undefined)), Effect.asVoid),
          { afterRevision: first.revision },
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v2"));
      yield* Deferred.await(secondSeen);
      yield* Fiber.interrupt(watcher);
      const second = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
      expect(received).toEqual([["model-v2", second.revision]]);

      // Publications on another instance must not advance this instance's revision or watermark.
      const otherInstanceId = ProviderInstanceId.make("acpRegistry_kimi");
      yield* coordinator.publishLiveConfiguration(otherInstanceId, configFor("kimi-v1"));
      expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual(second);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect(
    "preserves an unsuperseded catalog only for options-only updates targeting that catalog",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const instanceId = ProviderInstanceId.make("acpRegistry_devin");
        const effortOption = {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue: "low",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        };
        const catalogModels = [
          { id: "model-b", name: "Model B", description: null },
          { id: "model-c", name: "Model C", description: null },
        ];

        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: catalogModels,
          currentModelId: "model-b",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const catalogSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);

        // Options-only update targeting model-b keeps the active catalog in coordinator state.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [effortOption],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        const matchingOptionsSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(matchingOptionsSnap.revision).toBe(catalogSnap.revision + 1);
        expect(matchingOptionsSnap.catalogRevision).toBe(catalogSnap.catalogRevision);
        expect(matchingOptionsSnap.configuration).toEqual(
          Option.some({
            models: catalogModels,
            currentModelId: "model-b",
            configOptions: [effortOption],
            modelOptionIds: ["effort"],
            modelsFromModelSelect: true,
          }),
        );

        // An options-only update from another session running an absent model stores raw
        // so stored snapshots never lose the default marker compared to the PubSub stream.
        const foreignOptionsOnly = {
          models: [],
          currentModelId: "model-a",
          configOptions: [effortOption],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, foreignOptionsOnly);
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).configuration,
        ).toEqual(Option.some(foreignOptionsOnly));
      }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect(
    "clears live configuration conditionally by catalogRevision with retention and full-clear modes",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const instanceId = ProviderInstanceId.make("acpRegistry_devin");
        const effortOption = (currentValue: "low" | "high") => ({
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue,
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        });
        const configFor = (id: string) => ({
          models: [{ id, name: id, description: null }],
          currentModelId: id,
          configOptions: [],
          modelsFromModelSelect: true,
        });

        yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v1"));
        const first = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v2"));
        const second = yield* coordinator.getLiveConfigurationWithRevision(instanceId);

        // Outdated catalogRevision cannot clear a newer catalog or advance clearedThroughRevision.
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, first.revision, {
            catalogRevision: first.catalogRevision,
          }),
        ).toBe(false);
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).clearedThroughRevision,
        ).toBe(0);

        // Catalog-scoped clear validates newer in-flight options-only updates through retainConfiguration.
        const optionsOnlyConfig = {
          models: [],
          currentModelId: "model-v2",
          configOptions: [effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, optionsOnlyConfig);
        const optionsSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, second.revision, {
            catalogRevision: second.catalogRevision,
            retainConfiguration: (live) =>
              Option.some({
                ...live,
                configOptions: [effortOption("low")],
              }),
          }),
        ).toBe(true);
        expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual({
          ...optionsSnap,
          configuration: Option.some({
            ...optionsOnlyConfig,
            configOptions: [effortOption("low")],
          }),
          clearedThroughRevision: second.revision,
        });

        // clearOptions: true wipes both catalog and options and advances clearedThroughRevision past optionsSnap.
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, second.revision, {
            catalogRevision: second.catalogRevision,
            clearOptions: true,
          }),
        ).toBe(true);
        expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual({
          ...optionsSnap,
          configuration: Option.none(),
          clearedThroughRevision: optionsSnap.revision,
        });

        // Without retainConfiguration, clearing strips models while preserving non-empty options and drops empty ones.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          ...configFor("model-v3"),
          configOptions: [effortOption("low")],
          modelOptionIds: ["effort"],
        });
        const v3Snap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, v3Snap.revision, {
            catalogRevision: v3Snap.catalogRevision,
          }),
        ).toBe(true);
        expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual({
          ...v3Snap,
          configuration: Option.some({
            models: [],
            currentModelId: "model-v3",
            configOptions: [effortOption("low")],
            modelOptionIds: ["effort"],
            modelsFromModelSelect: false,
          }),
          clearedThroughRevision: v3Snap.revision,
        });

        yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v4"));
        const v4Snap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, v4Snap.revision, {
            catalogRevision: v4Snap.catalogRevision,
          }),
        ).toBe(true);
        expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual({
          ...v4Snap,
          configuration: Option.none(),
          clearedThroughRevision: v4Snap.revision,
        });
      }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it.effect("delivers concurrent live configuration publications in strict revision order", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const instanceId = ProviderInstanceId.make("acpRegistry_devin");
      const receivedRevisions: Array<number> = [];
      const allSeen = yield* Deferred.make<void>();
      const watcher = yield* coordinator
        .watchLiveConfiguration(instanceId, (_configuration, revision) =>
          Effect.sync(() => {
            receivedRevisions.push(revision);
            return receivedRevisions.length;
          }).pipe(
            Effect.flatMap((count) =>
              count === 4 ? Deferred.succeed(allSeen, undefined).pipe(Effect.asVoid) : Effect.void,
            ),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.forEach(
        [1, 2, 3, 4],
        (index) =>
          coordinator.publishLiveConfiguration(instanceId, {
            models:
              index % 2 === 1 ? [{ id: `m${index}`, name: `m${index}`, description: null }] : [],
            currentModelId: `m${index}`,
            configOptions: [],
            modelsFromModelSelect: index % 2 === 1,
          }),
        { concurrency: "unbounded", discard: true },
      );
      yield* Deferred.await(allSeen);
      yield* Fiber.interrupt(watcher);
      expect(receivedRevisions).toEqual([1, 2, 3, 4]);
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );
});
