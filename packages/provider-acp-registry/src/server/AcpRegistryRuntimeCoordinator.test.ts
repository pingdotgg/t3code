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
    "preserves the active catalog independently of options-only updates from any session",
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
        const catalogConfig = {
          models: [
            { id: "model-b", name: "Model B", description: null },
            { id: "model-c", name: "Model C", description: null },
          ],
          currentModelId: "model-b",
          configOptions: [],
          modelsFromModelSelect: true,
        };

        yield* coordinator.publishLiveConfiguration(instanceId, catalogConfig);
        const catalogSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(catalogSnap.catalog).toEqual(
          Option.some({ configuration: catalogConfig, revision: catalogSnap.revision }),
        );
        expect(catalogSnap.configuration).toEqual(Option.some(catalogConfig));
        expect(catalogSnap.pendingOptions).toEqual([]);

        // Options-only update targeting model-b keeps the active catalog separately from raw options.
        const matchingOptionsOnly = {
          models: [],
          currentModelId: "model-b",
          configOptions: [effortOption],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, matchingOptionsOnly);
        const matchingOptionsSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(matchingOptionsSnap.revision).toBe(catalogSnap.revision + 1);
        expect(matchingOptionsSnap.catalogRevision).toBe(catalogSnap.catalogRevision);
        expect(matchingOptionsSnap.catalog).toEqual(
          Option.some({ configuration: catalogConfig, revision: catalogSnap.revision }),
        );
        expect(matchingOptionsSnap.configuration).toEqual(Option.some(matchingOptionsOnly));
        expect(matchingOptionsSnap.pendingOptions).toEqual([
          { configuration: matchingOptionsOnly, revision: matchingOptionsSnap.revision },
        ]);

        // An options-only update from another session running an absent model neither discards
        // the active catalog nor drops earlier per-model pending options.
        const foreignOptionsOnly = {
          models: [],
          currentModelId: "model-a",
          configOptions: [effortOption],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, foreignOptionsOnly);
        const foreignSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(foreignSnap.catalog).toEqual(
          Option.some({ configuration: catalogConfig, revision: catalogSnap.revision }),
        );
        expect(foreignSnap.configuration).toEqual(Option.some(foreignOptionsOnly));
        expect(foreignSnap.pendingOptions).toEqual([
          { configuration: matchingOptionsOnly, revision: matchingOptionsSnap.revision },
          { configuration: foreignOptionsOnly, revision: foreignSnap.revision },
        ]);

        // A watcher behind the active catalog replays the catalog first, then each pending option update.
        const replayed: Array<readonly [number, string | null, number]> = [];
        const allReplayed = yield* Deferred.make<void>();
        const watcher = yield* coordinator
          .watchLiveConfiguration(
            instanceId,
            (configuration, revision) =>
              Effect.sync(() => {
                replayed.push([
                  configuration.models.length,
                  configuration.currentModelId,
                  revision,
                ] as const);
                return replayed.length;
              }).pipe(
                Effect.flatMap((count) =>
                  count === 3 ? Deferred.succeed(allReplayed, undefined) : Effect.void,
                ),
                Effect.asVoid,
              ),
            { afterRevision: 0 },
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(allReplayed);
        yield* Fiber.interrupt(watcher);
        expect(replayed).toEqual([
          [2, "model-b", catalogSnap.revision],
          [0, "model-b", matchingOptionsSnap.revision],
          [0, "model-a", foreignSnap.revision],
        ]);

        // A watcher already at the catalog revision receives only the pending raw options-only payloads.
        const optionsOnlyReplay: Array<readonly [number, string | null, number]> = [];
        const optionsReplayed = yield* Deferred.make<void>();
        const afterCatalogWatcher = yield* coordinator
          .watchLiveConfiguration(
            instanceId,
            (configuration, revision) =>
              Effect.sync(() => {
                optionsOnlyReplay.push([
                  configuration.models.length,
                  configuration.currentModelId,
                  revision,
                ] as const);
                return optionsOnlyReplay.length;
              }).pipe(
                Effect.flatMap((count) =>
                  count === 2 ? Deferred.succeed(optionsReplayed, undefined) : Effect.void,
                ),
                Effect.asVoid,
              ),
            { afterRevision: catalogSnap.revision },
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(optionsReplayed);
        yield* Fiber.interrupt(afterCatalogWatcher);
        expect(optionsOnlyReplay).toEqual([
          [0, "model-b", matchingOptionsSnap.revision],
          [0, "model-a", foreignSnap.revision],
        ]);
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

        expect(yield* coordinator.clearLiveConfiguration(instanceId)).toBe(0);

        yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v1"));
        const first = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, configFor("model-v2"));

        // Outdated catalogRevision cannot clear a newer catalog or advance clearedThroughRevision.
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
            catalogRevision: first.catalogRevision,
          }),
        ).toEqual(Option.none());
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).clearedThroughRevision,
        ).toBe(0);

        // Catalog-scoped clear reconciles catalog options plus newer per-model options-only
        // updates in revision order, stripping catalog models before passing to retain.
        const modeOption = (currentValue: "ask" | "code") => ({
          id: "mode",
          label: "Mode",
          type: "select" as const,
          currentValue,
          options: [
            { id: "ask", label: "Ask" },
            { id: "code", label: "Code" },
          ],
        });
        const variantOption = {
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue: "v1",
          options: [{ id: "v1", label: "V1" }],
        };
        const multiCatalog = {
          models: [
            { id: "model-v1", name: "model-v1", description: null },
            { id: "model-v2", name: "model-v2", description: null },
            { id: "model-v3", name: "model-v3", description: null },
          ],
          currentModelId: "model-v3",
          configOptions: [modeOption("code"), effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, multiCatalog);
        const third = yield* coordinator.getLiveConfigurationWithRevision(instanceId);

        const modelV1Options = {
          models: [],
          currentModelId: "model-v1",
          configOptions: [modeOption("code"), variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, modelV1Options);
        const v1Snap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);

        const modelV2Options = {
          models: [],
          currentModelId: "model-v2",
          configOptions: [modeOption("ask"), effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        };
        yield* coordinator.publishLiveConfiguration(instanceId, modelV2Options);
        const optionsSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);

        const seenRetainInputs: Array<readonly [string | null, number, boolean]> = [];
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
            catalogRevision: third.catalogRevision,
            retain: (live) => {
              seenRetainInputs.push([
                live.currentModelId,
                live.models.length,
                live.modelsFromModelSelect === true,
              ]);
              if (live.currentModelId === "model-v2") {
                return Option.some({
                  ...live,
                  configOptions: [modeOption("ask"), effortOption("low")],
                  partialOptions: true,
                });
              }
              return Option.some({ ...live, partialOptions: true });
            },
          }),
        ).toEqual(Option.some(optionsSnap.revision));
        // Every candidate passed to retain has catalog models and provenance stripped.
        expect(seenRetainInputs).toEqual([
          ["model-v3", 0, false],
          ["model-v1", 0, false],
          ["model-v2", 0, false],
        ]);
        const retainedV3 = {
          models: [],
          currentModelId: "model-v3",
          configOptions: [effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
          partialOptions: true,
          preserveDefault: true,
        };
        const retainedV1 = {
          models: [],
          currentModelId: "model-v1",
          configOptions: [variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          partialOptions: true,
          preserveDefault: true,
        };
        const retainedV2 = {
          ...modelV2Options,
          configOptions: [modeOption("ask"), effortOption("low")],
          partialOptions: true,
        };
        expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual({
          ...optionsSnap,
          catalog: Option.none(),
          configuration: Option.some(retainedV2),
          pendingOptions: [
            { configuration: retainedV3, revision: third.revision },
            { configuration: retainedV1, revision: v1Snap.revision },
            { configuration: retainedV2, revision: optionsSnap.revision },
          ],
          clearedThroughRevision: optionsSnap.revision,
        });

        // Omitting retain wipes both catalog and options while keeping clearedThroughRevision.
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
            catalogRevision: third.catalogRevision,
          }),
        ).toEqual(Option.some(optionsSnap.revision));
        expect(
          yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
            catalogRevision: third.catalogRevision,
          }),
        ).toEqual(Option.some(optionsSnap.revision));
        expect(yield* coordinator.getLiveConfigurationWithRevision(instanceId)).toEqual({
          ...optionsSnap,
          catalog: Option.none(),
          configuration: Option.none(),
          pendingOptions: [],
          clearedThroughRevision: optionsSnap.revision,
        });

        // Per-model pending options are bounded at 256 models, evicting the oldest entry first
        // even when clearLiveConfigurationIfRevision also includes catalog options.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [{ id: "catalog-model", name: "catalog-model", description: null }],
          currentModelId: "catalog-model",
          configOptions: [effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        const catalogForCap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        for (let index = 0; index < 257; index += 1) {
          yield* coordinator.publishLiveConfiguration(instanceId, {
            models: [],
            currentModelId: `m${index}`,
            configOptions: [effortOption("high")],
            modelOptionIds: ["effort"],
            modelsFromModelSelect: false,
          });
        }
        const bounded = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(bounded.pendingOptions).toHaveLength(256);
        expect(bounded.pendingOptions[0]?.configuration.currentModelId).toBe("m1");
        expect(bounded.pendingOptions.at(-1)?.configuration.currentModelId).toBe("m256");

        // Clear retention caps pendingOptions at 256 even when catalog options plus 256
        // per-model updates are all retained (evicting the oldest entry, catalog-model).
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: catalogForCap.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const clearedCap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(clearedCap.pendingOptions).toHaveLength(256);
        expect(clearedCap.pendingOptions[0]?.configuration.currentModelId).toBe("m1");
        expect(clearedCap.pendingOptions.at(-1)?.configuration.currentModelId).toBe("m256");

        // When retain drops the newest update (m256) while earlier models survive with
        // preserveDefault, getLiveConfiguration returns none so Copilot does not read an
        // earlier model's effort.
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: catalogForCap.catalogRevision,
              retain: (live) =>
                live.currentModelId === "m256"
                  ? Option.none()
                  : Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const clearedEarlierOnly = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(clearedEarlierOnly.configuration).toEqual(Option.none());
        expect(clearedEarlierOnly.pendingOptions).toHaveLength(255);
        expect(clearedEarlierOnly.pendingOptions.at(-1)?.configuration.currentModelId).toBe("m255");
        expect(clearedEarlierOnly.pendingOptions.at(-1)?.configuration.preserveDefault).toBe(true);

        // An earlier update with no current-model options still survives clear when it carries
        // retained advertisedReasoning (stripping shared options and preserving default).
        const advertisedC = effortOption("low");
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "model-b", name: "Model B", description: null },
            { id: "model-c", name: "Model C", description: null },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const advertisedCatalog = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-c": advertisedC },
        });
        const bAdvSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: advertisedCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterAdvClear = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(afterAdvClear.pendingOptions).toEqual([
          {
            revision: bAdvSnap.revision,
            configuration: {
              models: [],
              currentModelId: "model-b",
              configOptions: [],
              modelOptionIds: [],
              modelsFromModelSelect: false,
              partialOptions: true,
              preserveDefault: true,
              advertisedReasoning: { "model-c": advertisedC },
            },
          },
          {
            revision: afterAdvClear.revision,
            configuration: {
              models: [],
              currentModelId: "model-a",
              configOptions: [modeOption("ask")],
              modelOptionIds: [],
              modelsFromModelSelect: false,
              partialOptions: true,
            },
          },
        ]);
        // If retain strips advertisedReasoning (e.g. probe disabled reasoning for model-c)
        // and model-b has no model-specific options, the earlier entry is dropped.
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: advertisedCatalog.catalogRevision,
              retain: (live) => {
                const { advertisedReasoning: _dropped, ...rest } = live;
                return Option.some({ ...rest, partialOptions: true });
              },
            }),
          ),
        ).toBe(true);
        const afterDisabledClear = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(afterDisabledClear.pendingOptions).toHaveLength(1);
        expect(afterDisabledClear.pendingOptions[0]?.configuration.currentModelId).toBe("model-a");

        // Stripping a catalog entry extracts non-current models' reasoningEffort into
        // advertisedReasoning for retain, while excluding currentModelId and reasoningEffort: null.
        const highEffort = effortOption("high");
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null, reasoningEffort: highEffort },
            { id: "model-b", name: "Model B", description: null, reasoningEffort: highEffort },
            { id: "model-c", name: "Model C", description: null, reasoningEffort: null },
          ],
          currentModelId: "model-a",
          configOptions: [effortOption("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        const reasoningCatalog = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: reasoningCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterCatalogReasoningClear =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterCatalogReasoningClear.pendingOptions[0]?.configuration.advertisedReasoning,
        ).toEqual({
          "model-b": highEffort,
        });

        // A same-model options-only update for model-a overrides model-a's own options without
        // discarding catalog reasoning for untouched models (model-c), while never carrying older
        // catalog reasoning over a model updated at an intervening revision (model-b).
        const lowEffort = effortOption("low");
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null, reasoningEffort: highEffort },
            { id: "model-b", name: "Model B", description: null, reasoningEffort: lowEffort },
            { id: "model-c", name: "Model C", description: null, reasoningEffort: lowEffort },
          ],
          currentModelId: "model-a",
          configOptions: [effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        const sameModelCatalog = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [highEffort],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        const modelBHigherSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: sameModelCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterSameModelClear = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(afterSameModelClear.pendingOptions).toHaveLength(2);
        expect(afterSameModelClear.pendingOptions[0]).toEqual({
          revision: modelBHigherSnap.revision,
          configuration: {
            models: [],
            currentModelId: "model-b",
            configOptions: [highEffort],
            modelOptionIds: ["effort"],
            modelsFromModelSelect: false,
            partialOptions: true,
            preserveDefault: true,
          },
        });
        expect(afterSameModelClear.pendingOptions[1]?.configuration.configOptions).toEqual([
          modeOption("ask"),
        ]);
        expect(afterSameModelClear.pendingOptions[1]?.configuration.advertisedReasoning).toEqual({
          "model-c": lowEffort,
        });

        // Cross-model advertisedReasoning supersedes older catalog reasoning even when a
        // subsequent same-model update replaces the publishing model's pending entry without
        // repeating that metadata (preserving the newer high value alongside untouched catalog models).
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null, reasoningEffort: highEffort },
            { id: "model-b", name: "Model B", description: null, reasoningEffort: lowEffort },
            { id: "model-d", name: "Model D", description: null, reasoningEffort: lowEffort },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const crossModelCatalog = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        // Case 1: model-x advertises model-b: high and stays in optionsByModel; model-a update
        // must not carry older catalog model-b: low over model-x's newer observation.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-x",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": highEffort },
        });
        const modelXSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: crossModelCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterCrossModelClear =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterCrossModelClear.pendingOptions.find((e) => e.revision === modelXSnap.revision)
            ?.configuration.advertisedReasoning,
        ).toEqual({ "model-b": highEffort });
        expect(
          afterCrossModelClear.pendingOptions.at(-1)?.configuration.advertisedReasoning,
        ).toEqual({ "model-d": lowEffort });

        // Second probe clear: if model-x later republishes without model-b metadata and a second
        // clear runs, model-b's retained highEffort must still survive in reasoningByModel.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-x",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: crossModelCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterSecondCrossClear =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterSecondCrossClear.pendingOptions.find((e) => e.revision === modelXSnap.revision),
        ).toEqual({
          revision: modelXSnap.revision,
          configuration: {
            models: [],
            modelsFromModelSelect: false,
            currentModelId: null,
            configOptions: [],
            advertisedReasoning: { "model-b": highEffort },
            partialOptions: true,
            preserveDefault: true,
          },
        });

        // Case 2: model-c advertises model-b: high, then another session replaces model-c without
        // model-b metadata before model-a updates and a probe clears; both live replay (snapshot &
        // watcher catch-up) and post-clear retention keep model-b: high at its original revision
        // with preserveDefault: true so default selection is untouched.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null, reasoningEffort: highEffort },
            { id: "model-b", name: "Model B", description: null, reasoningEffort: lowEffort },
            { id: "model-d", name: "Model D", description: null, reasoningEffort: lowEffort },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const replacedCrossCatalog =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": highEffort },
        });
        const modelCReasoningSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        const beforeClearReplacedSnap =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(beforeClearReplacedSnap.pendingOptions).toEqual([
          {
            revision: modelCReasoningSnap.revision,
            configuration: {
              models: [],
              modelsFromModelSelect: false,
              currentModelId: null,
              configOptions: [],
              advertisedReasoning: { "model-b": highEffort },
              preserveDefault: true,
            },
          },
          {
            revision: beforeClearReplacedSnap.revision,
            configuration: {
              models: [],
              currentModelId: "model-c",
              configOptions: [modeOption("code")],
              modelOptionIds: [],
              modelsFromModelSelect: false,
            },
          },
        ]);
        const replayedByWatcher: Array<{
          readonly revision: number;
          readonly currentModelId: string | null;
          readonly preserveDefault: boolean | undefined;
          readonly advertisedB: string | boolean | undefined;
        }> = [];
        const watcherDone = yield* Deferred.make<void>();
        const watcherFiber = yield* coordinator
          .watchLiveConfiguration(
            instanceId,
            (configuration, revision) =>
              Effect.sync(() => {
                replayedByWatcher.push({
                  revision,
                  currentModelId: configuration.currentModelId,
                  preserveDefault: configuration.preserveDefault,
                  advertisedB: configuration.advertisedReasoning?.["model-b"]?.currentValue,
                });
              }).pipe(
                Effect.flatMap(() =>
                  replayedByWatcher.length === 2
                    ? Deferred.succeed(watcherDone, undefined)
                    : Effect.void,
                ),
              ),
            { afterRevision: replacedCrossCatalog.revision },
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(watcherDone);
        yield* Fiber.interrupt(watcherFiber);
        expect(replayedByWatcher).toEqual([
          {
            revision: modelCReasoningSnap.revision,
            currentModelId: null,
            preserveDefault: true,
            advertisedB: "high",
          },
          {
            revision: beforeClearReplacedSnap.revision,
            currentModelId: "model-c",
            preserveDefault: undefined,
            advertisedB: undefined,
          },
        ]);

        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: replacedCrossCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterReplacedCrossClear =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterReplacedCrossClear.pendingOptions.find(
            (e) => e.revision === modelCReasoningSnap.revision,
          ),
        ).toEqual({
          revision: modelCReasoningSnap.revision,
          configuration: {
            models: [],
            modelsFromModelSelect: false,
            currentModelId: null,
            configOptions: [],
            advertisedReasoning: { "model-b": highEffort },
            partialOptions: true,
            preserveDefault: true,
          },
        });
        expect(
          afterReplacedCrossClear.pendingOptions.at(-1)?.configuration.advertisedReasoning,
        ).toEqual({
          "model-d": lowEffort,
        });

        // A follow-up clear whose retain drops only the orphaned reasoning entry must update
        // stored state rather than short-circuiting as a no-op.
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: replacedCrossCatalog.catalogRevision,
              retain: (live) =>
                live.currentModelId === null
                  ? Option.none()
                  : Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).pendingOptions.some(
            (e) => e.configuration.advertisedReasoning?.["model-b"] !== undefined,
          ),
        ).toBe(false);

        // Orphan replay preserves __proto__ as an own property alongside other slugs in the same
        // revision, and retainedReasoning caps at 256 while evicting older revisions first.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-proto",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: Object.fromEntries([
            ["model-b", highEffort],
            ["__proto__", lowEffort],
          ]),
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-proto",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        const protoOrphanBeforeClear = (yield* coordinator.getLiveConfigurationWithRevision(
          instanceId,
        )).pendingOptions.find((e) => e.configuration.currentModelId === null)?.configuration
          .advertisedReasoning;
        expect(protoOrphanBeforeClear?.["model-b"]).toEqual(highEffort);
        expect(
          protoOrphanBeforeClear !== undefined &&
            Object.hasOwn(protoOrphanBeforeClear, "__proto__"),
        ).toBe(true);
        expect(protoOrphanBeforeClear?.["__proto__"]).toEqual(lowEffort);
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: replacedCrossCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const protoOrphanAfterClear = (yield* coordinator.getLiveConfigurationWithRevision(
          instanceId,
        )).pendingOptions.find((e) => e.configuration.currentModelId === null)?.configuration
          .advertisedReasoning;
        expect(
          protoOrphanAfterClear !== undefined && Object.hasOwn(protoOrphanAfterClear, "__proto__"),
        ).toBe(true);
        expect(protoOrphanAfterClear?.["__proto__"]).toEqual(lowEffort);

        // Retained reasoning caps at 256 during clear and evicts older orphaned entries before
        // newer candidates (1 orphan + 255 newer candidates + 1 preserved catalog reasoning entry
        // carried by a newer same-model update = 257 entries entering retention).
        yield* coordinator.clearLiveConfiguration(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "catalog-pub", name: "Catalog Pub", description: null },
            {
              id: "catalog-model",
              name: "Catalog Model",
              description: null,
              reasoningEffort: lowEffort,
            },
          ],
          currentModelId: "catalog-pub",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const capCatalog = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "orphan-pub",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "oldest-orphan": highEffort },
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "orphan-pub",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        const newerAdvertised = Object.fromEntries(
          Array.from({ length: 255 }, (_, index) => [`newer-${index}`, lowEffort]),
        );
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "cand-pub",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: newerAdvertised,
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "catalog-pub",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).pendingOptions.some(
            (e) => e.configuration.advertisedReasoning?.["oldest-orphan"] !== undefined,
          ),
        ).toBe(true);
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: capCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterCapClear = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterCapClear.pendingOptions.some(
            (e) => e.configuration.advertisedReasoning?.["oldest-orphan"] !== undefined,
          ),
        ).toBe(false);
        expect(
          afterCapClear.pendingOptions.some(
            (e) => e.configuration.advertisedReasoning?.["newer-0"] !== undefined,
          ),
        ).toBe(true);
        expect(
          afterCapClear.pendingOptions.some(
            (e) => e.configuration.advertisedReasoning?.["catalog-model"] !== undefined,
          ),
        ).toBe(true);

        // Case 3: When model-b later reports its own full option set (either with no reasoning or
        // its own lowEffort), older pending cross-model advertisedReasoning for model-b is dropped
        // immediately so even 256+ subsequent reasoning evictions never let model-c resurrect it.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "model-b", name: "Model B", description: null },
            { id: "model-c", name: "Model C", description: null },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const dropReasoningCatalog =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": highEffort },
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        // Cycle reasoningByModel past the 256 cap while model-c stays in optionsByModel.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-churn",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: Object.fromEntries(
            Array.from({ length: 260 }, (_, index) => [`churn-${index}`, lowEffort]),
          ),
        });
        const afterModelBDroppedReasoning =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterModelBDroppedReasoning.pendingOptions.some(
            (e) => e.configuration.advertisedReasoning?.["model-b"] !== undefined,
          ),
        ).toBe(false);
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: dropReasoningCatalog.catalogRevision,
              retain: (live) =>
                live.currentModelId === "model-churn" ||
                (live.currentModelId === "model-b" && live.configOptions.length === 0)
                  ? Option.none()
                  : Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).pendingOptions,
        ).toEqual([]);

        // Case 4: After model-c advertises model-b: high and is replaced, model-b publishing its
        // own lowEffort supersedes the orphaned highEffort so model-b keeps lowEffort after clear.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": highEffort },
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [lowEffort],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: dropReasoningCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterSelfSupersedeClear =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterSelfSupersedeClear.pendingOptions.map((e) => [
            e.configuration.currentModelId,
            e.configuration.configOptions.map((o) => o.currentValue),
            e.configuration.advertisedReasoning?.["model-b"]?.currentValue ?? null,
          ]),
        ).toEqual([
          ["model-b", ["low"], null],
          ["model-a", ["ask"], null],
        ]);

        // Case 5: Newer cross-model advertisedReasoning (model-y: low, then model-y replaced)
        // supersedes older cross-model advertisedReasoning (model-x: high) instead of letting
        // model-x's stale high survive.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-x",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": highEffort },
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-y",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": lowEffort },
        });
        const modelYReasoningSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-y",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: dropReasoningCatalog.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterCrossSupersedeClear =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterCrossSupersedeClear.pendingOptions
            .filter((e) => e.configuration.advertisedReasoning?.["model-b"] !== undefined)
            .map((e) => [
              e.revision,
              e.configuration.currentModelId,
              e.configuration.advertisedReasoning?.["model-b"]?.currentValue,
            ]),
        ).toEqual([[modelYReasoningSnap.revision, null, "low"]]);

        // Case 6: Full clearLiveConfiguration and a fresh catalog publish both reset tracked
        // reasoningByModel and catalogReasoningSupersededSlugs, and clearLiveConfiguration returns
        // the advanced cleared-through watermark.
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-x",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        const beforeFullClear = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(beforeFullClear.clearedThroughRevision).toBeLessThan(beforeFullClear.revision);
        expect(yield* coordinator.clearLiveConfiguration(instanceId)).toBe(
          beforeFullClear.revision,
        );
        expect(yield* coordinator.clearLiveConfiguration(instanceId)).toBe(
          beforeFullClear.revision,
        );
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).pendingOptions,
        ).toEqual([]);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "model-b", name: "Model B", description: null, reasoningEffort: lowEffort },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": highEffort },
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "model-c",
          configOptions: [modeOption("code")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "model-b", name: "Model B", description: null, reasoningEffort: lowEffort },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const freshCatalogAfterSupersede =
          yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: freshCatalogAfterSupersede.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(instanceId)).pendingOptions.map(
            (e) => e.configuration.advertisedReasoning?.["model-b"]?.currentValue,
          ),
        ).toEqual(["low"]);

        // Earlier displaced tail updates (both overflow m256 and displaced ordinary tail m255)
        // keep their tail metadata alongside preserveDefault so the driver can learn their options
        // off-screen without swapping slot 255 or default, while non-tail models (m1) drop it.
        const overflowModel = { id: "m256", name: "Model 256", description: null };
        const ordinaryTailModel = { id: "m255", name: "Model 255", description: null };
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "m256",
          configOptions: [modeOption("code"), variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          cappedPrefixKey: "prefix-255",
          cappedLastModel: overflowModel,
          cappedTailIsOverflow: true,
        });
        const overflowSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "m255",
          configOptions: [modeOption("code"), variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          cappedPrefixKey: "prefix-255",
          cappedLastModel: ordinaryTailModel,
        });
        const ordinaryTailSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "m1",
          configOptions: [variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          cappedPrefixKey: "prefix-255",
          cappedLastModel: ordinaryTailModel,
        });
        const nonTailSnap = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          models: [],
          currentModelId: "m0",
          configOptions: [modeOption("ask")],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          cappedPrefixKey: "prefix-255",
          cappedLastModel: ordinaryTailModel,
        });
        expect(
          Option.isSome(
            yield* coordinator.clearLiveConfigurationIfRevision(instanceId, {
              catalogRevision: freshCatalogAfterSupersede.catalogRevision,
              retain: (live) => Option.some({ ...live, partialOptions: true }),
            }),
          ),
        ).toBe(true);
        const afterOverflowClear = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
        expect(
          afterOverflowClear.pendingOptions.find(
            (entry) => entry.revision === overflowSnap.revision,
          )?.configuration,
        ).toEqual({
          models: [],
          currentModelId: "m256",
          configOptions: [variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          partialOptions: true,
          preserveDefault: true,
          cappedPrefixKey: "prefix-255",
          cappedLastModel: overflowModel,
          cappedTailIsOverflow: true,
        });
        expect(
          afterOverflowClear.pendingOptions.find(
            (entry) => entry.revision === ordinaryTailSnap.revision,
          )?.configuration,
        ).toEqual({
          models: [],
          currentModelId: "m255",
          configOptions: [variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          partialOptions: true,
          preserveDefault: true,
          cappedPrefixKey: "prefix-255",
          cappedLastModel: ordinaryTailModel,
        });
        expect(
          afterOverflowClear.pendingOptions.find((entry) => entry.revision === nonTailSnap.revision)
            ?.configuration,
        ).toEqual({
          models: [],
          currentModelId: "m1",
          configOptions: [variantOption],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
          partialOptions: true,
          preserveDefault: true,
        });
      }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );
});
