import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { AcpRegistryCatalog } from "../acp/AcpRegistrySupport.ts";
import { AcpRegistryRuntimeCoordinator } from "../acp/AcpRegistryRuntimeCoordinator.ts";
import { DevinModelCatalog } from "../acp/DevinModels.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { upsertProviderWorkspaceSnapshot } from "../Layers/ProviderRegistry.ts";
import { AcpRegistryDriver } from "./AcpRegistryDriver.ts";

const encodeCatalog = Schema.encodeSync(DevinModelCatalog);

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-devin-discovery-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettings.layerTest(),
  IdAllocator.layer,
  AcpRegistryRuntimeCoordinator.layer,
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
);

it.effect("keeps the CLI catalog through skipped readiness probes and replaces it when empty", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-cli-" });
    const catalogPath = path.join(cwd, "models.json");
    yield* fs.writeFileString(
      catalogPath,
      encodeCatalog({
        families: [
          {
            slug: "opus",
            family_label: "Opus",
            variants: [{ model_uid: "native-high", label: "Opus High" }],
          },
        ],
      }),
    );
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const command = writeFakeCli({
      directory: cwd,
      name: "devin",
      platform: yield* HostProcessPlatform,
      source: `
        import { readFileSync } from 'node:fs';
        const commandArgs = process.argv.slice(2).join(' ');
        if (commandArgs === 'models list --format json') {
          process.stdout.write(readFileSync(process.env.T3_TEST_MODELS_PATH, 'utf8')); process.exit(0);
        }
        if (commandArgs === 'skills list --json') { process.stdout.write('[]'); process.exit(0); }
        ${execScriptSource({ scriptPath: mockAgentPath })}
      `,
    });
    const catalog = Layer.mock(AcpRegistryCatalog)({
      inspect: () =>
        Effect.succeed({
          status: "ready",
          agentId: "devin",
          version: "1.0.0",
          distribution: "binary",
        }),
      resolve: () =>
        Effect.succeed({
          agent: {
            id: "devin",
            name: "Devin",
            version: "1.0.0",
            description: "Fixture",
            distribution: {},
          },
          distribution: "binary",
          spawn: {
            command,
            args: ["acp"],
            cwd: config.cwd,
            env: {
              T3_TEST_MODELS_PATH: catalogPath,
              T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "0",
            },
          },
        }),
    });
    const coordinator = yield* AcpRegistryRuntimeCoordinator;
    const startDiscovery = yield* Deferred.make<void>();
    const skippedDiscovery = yield* Deferred.make<void>();
    const instanceId = ProviderInstanceId.make("acpRegistry_devin");
    const instance = yield* AcpRegistryDriver.create({
      instanceId,
      displayName: "Devin",
      accentColor: undefined,
      environment: [],
      enabled: true,
      config: { ...AcpRegistryDriver.defaultConfig(), agentId: "devin", commandPath: command },
    }).pipe(
      Effect.provide(catalog),
      Effect.provideService(AcpRegistryRuntimeCoordinator, {
        ...coordinator,
        runBackgroundProbe: (agentId, probe) =>
          Deferred.await(startDiscovery).pipe(
            Effect.andThen(coordinator.runBackgroundProbe(agentId, probe)),
            Effect.tap((result) =>
              Option.isNone(result) ? Deferred.succeed(skippedDiscovery, undefined) : Effect.void,
            ),
          ),
      }),
    );
    expect((yield* instance.snapshot.getSnapshot).models).toEqual([]);
    const [discovered] = yield* Effect.all(
      [
        instance.snapshot.streamChanges.pipe(
          Stream.filter((provider) => provider.models.some((model) => model.slug === "opus")),
          Stream.runHead,
        ),
        Deferred.succeed(startDiscovery, undefined),
      ],
      { concurrency: "unbounded" },
    );
    expect(Option.isSome(discovered)).toBe(true);

    yield* coordinator.publishLiveConfiguration(instanceId, {
      models: [{ id: "native-high", name: "Opus High", description: null }],
      currentModelId: "native-high",
      configOptions: [],
    });
    const refreshed = yield* coordinator.withForegroundStartup(
      "devin",
      Effect.gen(function* () {
        const provider = yield* instance.snapshot.refresh;
        yield* Deferred.await(skippedDiscovery);
        return provider;
      }),
    );
    expect(refreshed.auth.status).toBe("authenticated");
    expect(refreshed.models.map((model) => model.slug)).toEqual(["opus"]);

    const workspace = yield* instance.snapshotForCwd!(cwd);
    expect(workspace).not.toBeNull();
    expect(workspace).not.toHaveProperty("slashCommands");
    const provider = upsertProviderWorkspaceSnapshot(refreshed, cwd, workspace!);
    expect(provider.workspaceSnapshots?.[0]).toMatchObject({
      slashCommandsSource: "provider",
      slashCommands: refreshed.slashCommands,
      skills: [],
    });

    // Expire the successful catalog cache; no background work runs without demand.
    yield* TestClock.adjust("1 hour");
    yield* fs.writeFileString(catalogPath, encodeCatalog({ families: [] }));
    const [empty] = yield* Effect.all(
      [
        instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (provider) => provider.auth.status === "authenticated" && provider.models.length === 0,
          ),
          Stream.runHead,
        ),
        instance.snapshot.refresh,
      ],
      { concurrency: "unbounded" },
    );
    expect(Option.isSome(empty)).toBe(true);
    expect((yield* instance.snapshot.refresh).models).toEqual([]);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
