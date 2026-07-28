import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { layer as HermesSessionBindingRepositoryLayer } from "../../hermes/HermesSessionBindingRepository.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2 } from "../../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { layer as IdAllocatorV2Layer } from "../../orchestration-v2/IdAllocator.ts";
import {
  hermesModelOverride,
  hermesFastOverride,
  resolveHermesGatewayToken,
  resolveHermesRemotePairingToken,
  resolveHermesRemoteTlsCertificateSha256,
} from "../../orchestration-v2/Adapters/HermesServeAdapterV2.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { HermesDriver, hermesProviderModels, hermesSlashCommands } from "./HermesDriver.ts";

const ServerConfigTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-hermes-driver-test-",
});
const TestLayer = Layer.mergeAll(
  IdAllocatorV2Layer,
  HermesSessionBindingRepositoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  ServerConfigTestLayer,
).pipe(Layer.provideMerge(NodeServices.layer));
const decodeHermesSettingsEffect = Schema.decodeUnknownEffect(HermesSettings);

describe("HermesDriver", () => {
  it("presents the default sentinel as the effective Hermes model with live options", () => {
    const models = hermesProviderModels(
      {
        model: "gpt-5.6-sol",
        provider: "openai",
        providers: [
          {
            slug: "openai",
            name: "OpenAI",
            models: ["gpt-5.6-sol", "gpt-5.4"],
            capabilities: {
              "gpt-5.6-sol": { fast: true, reasoning: true },
              "gpt-5.4": { fast: false, reasoning: true },
            },
          },
        ],
      },
      { value: "high", display: "show" },
      { value: "fast" },
      ["default"],
    );

    assert.deepInclude(models[0], {
      slug: "default",
      name: "GPT-5.6 Sol",
      isDefault: true,
    });
    assert.deepEqual(
      models[0]!.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
      [
        ["reasoningEffort", "high"],
        ["fast", "fast"],
      ],
    );
  });

  it("deduplicates model slugs exposed by multiple Hermes upstream providers", () => {
    const models = hermesProviderModels(
      {
        model: "grok-4.5",
        provider: "xai",
        providers: [
          {
            slug: "xai",
            name: "xAI",
            models: ["grok-4.5"],
            capabilities: { "grok-4.5": { reasoning: true } },
          },
          {
            slug: "opencode",
            name: "OpenCode",
            models: ["grok-4.5"],
            capabilities: { "grok-4.5": { reasoning: true } },
          },
        ],
      },
      { value: "medium", display: "show" },
      { value: "normal" },
      ["default"],
    );

    assert.strictEqual(models.filter((model) => model.slug === "grok-4.5").length, 1);
    assert.strictEqual(models.find((model) => model.slug === "grok-4.5")?.subProvider, "xAI");
  });

  it("resolves default-model capabilities from the active provider on duplicate slugs", () => {
    const models = hermesProviderModels(
      {
        model: "grok-4.5",
        provider: "xai",
        providers: [
          {
            slug: "opencode",
            name: "OpenCode",
            models: ["grok-4.5"],
            capabilities: { "grok-4.5": { fast: true, reasoning: false } },
          },
          {
            slug: "xai",
            name: "xAI",
            is_current: true,
            models: ["grok-4.5"],
            capabilities: { "grok-4.5": { fast: false, reasoning: true } },
          },
        ],
      },
      { value: "medium", display: "show" },
      { value: "normal" },
      ["default"],
    );

    assert.deepEqual(
      models
        .find((model) => model.slug === "default")
        ?.capabilities?.optionDescriptors?.map((option) => option.id),
      ["reasoningEffort"],
    );
  });

  it("surfaces catalog aliases and falls back to official gateway commands", () => {
    const live = hermesSlashCommands({
      pairs: [["/background", "Run in background (usage: /background <prompt>)"]],
      canon: { "/background": "/background", "/bg": "/background" },
      sub: { "/background": ["<prompt>"] },
    });
    assert.deepInclude(live, {
      name: "bg",
      description: "Alias for /background",
      input: { hint: "<prompt>" },
    });

    const fallback = hermesSlashCommands(undefined);
    for (const gatewayCommand of [
      "new",
      "reset",
      "topic",
      "approve",
      "deny",
      "reasoning",
      "skills",
      "commands",
      "restart",
      "platform",
    ]) {
      assert.isTrue(
        fallback.some((command) => command.name === gatewayCommand),
        `expected fallback /${gatewayCommand}`,
      );
    }
    assert.deepInclude(
      fallback.find((command) => command.name === "model"),
      {
        name: "model",
        input: { hint: "[model] [--provider name] [--global|--session] [--refresh]" },
      },
    );
    assert.deepInclude(
      fallback.find((command) => command.name === "clear"),
      {
        name: "clear",
        description: "Clear the visible T3 Work timeline without resetting Hermes context",
      },
    );
  });

  it("decodes a safe default config and accepts explicit loopback/profile settings", () => {
    const decode = Schema.decodeSync(HermesSettings);
    assert.deepEqual(decode({}), {
      enabled: false,
      endpoint: "",
      remoteAccessEnabled: false,
      profileKey: "default",
      managedServerEnabled: true,
      customModels: [],
      importEnabled: false,
      mcpEnabled: true,
      attachmentsEnabled: true,
      proactiveEnabled: false,
      voiceEnabled: false,
    });
    assert.deepEqual(
      decode({
        endpoint: "ws://127.0.0.1:9119/api/ws",
        profileKey: "real-profile",
        customModels: ["custom/model"],
      }),
      {
        enabled: false,
        endpoint: "ws://127.0.0.1:9119/api/ws",
        remoteAccessEnabled: false,
        profileKey: "real-profile",
        managedServerEnabled: true,
        customModels: ["custom/model"],
        importEnabled: false,
        mcpEnabled: true,
        attachmentsEnabled: true,
        proactiveEnabled: false,
        voiceEnabled: false,
      },
    );
  });

  it("only consumes a non-empty sensitive instance token", () => {
    assert.equal(
      resolveHermesGatewayToken([
        { name: "HERMES_GATEWAY_TOKEN", value: "secret", sensitive: true },
      ]),
      "secret",
    );
    assert.isUndefined(
      resolveHermesGatewayToken([
        { name: "HERMES_GATEWAY_TOKEN", value: "plain", sensitive: false },
      ]),
    );
    assert.isUndefined(
      resolveHermesGatewayToken([{ name: "HERMES_GATEWAY_TOKEN", value: "", sensitive: true }]),
    );
  });

  it("only consumes dedicated sensitive remote trust and pairing variables", () => {
    const environment = [
      { name: "HERMES_GATEWAY_TOKEN", value: "broad-token", sensitive: true },
      { name: "HERMES_REMOTE_PAIRING_TOKEN", value: "pairing-token", sensitive: true },
      {
        name: "HERMES_REMOTE_TLS_CERT_SHA256",
        value: "ab".repeat(32),
        sensitive: true,
      },
      { name: "MCP_API_TOKEN", value: "must-not-be-used", sensitive: true },
    ];

    assert.equal(resolveHermesRemotePairingToken(environment), "pairing-token");
    assert.equal(resolveHermesRemoteTlsCertificateSha256(environment), "ab".repeat(32));
    assert.isUndefined(
      resolveHermesRemotePairingToken([
        { name: "HERMES_REMOTE_PAIRING_TOKEN", value: "plain", sensitive: false },
      ]),
    );
  });

  it("omits the profile default model and forwards only explicit custom slugs", () => {
    assert.deepEqual(hermesModelOverride("default"), {});
    assert.deepEqual(hermesModelOverride("custom/model"), { model: "custom/model" });
  });

  it("maps the effective fast option onto fresh Hermes sessions", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("hermes"),
      model: "default",
      options: [{ id: "fast", value: "fast" }],
    };
    assert.deepEqual(hermesFastOverride(selection), { fast: true });
    assert.deepEqual(
      hermesFastOverride({ ...selection, options: [{ id: "fast", value: "normal" }] }),
      { fast: false },
    );
  });

  it("is registered in both built-in driver catalogs", () => {
    assert.isTrue(BUILT_IN_DRIVERS.includes(HermesDriver));
    assert.isTrue(
      BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2.some((driver) => driver.driverKind === "hermes"),
    );
  });

  it.effect(
    "advertises default/custom models while disabled and keeps text generation unsupported",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* decodeHermesSettingsEffect({
            endpoint: "ws://127.0.0.1:9119/api/ws",
            profileKey: "real-profile",
            customModels: ["custom/model"],
          });
          const instance = yield* HermesDriver.create({
            instanceId: ProviderInstanceId.make("hermes_disabled"),
            displayName: "Hermes local",
            accentColor: undefined,
            environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "secret", sensitive: true }],
            enabled: false,
            config,
          });
          const snapshot = yield* instance.snapshot.getSnapshot;
          const textGeneration = yield* Effect.result(
            instance.textGeneration.generateThreadTitle({
              cwd: "/tmp/hermes-project",
              message: "ignored",
              modelSelection: {
                instanceId: ProviderInstanceId.make("hermes_disabled"),
                model: "default",
              },
            }),
          );

          assert.equal(snapshot.status, "disabled");
          assert.deepEqual(
            snapshot.models.map((model) => model.slug),
            ["default", "custom/model"],
          );
          assert.equal(textGeneration._tag, "Failure");
          assert.isNull(instance.snapshot.maintenanceCapabilities.update);
          assert.isUndefined(instance.hermesSessionCatalog);
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("only reports an enabled Hermes instance ready when setup is complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const incompleteConfig = yield* decodeHermesSettingsEffect({
          profileKey: "default",
        });
        const incomplete = yield* HermesDriver.create({
          instanceId: ProviderInstanceId.make("hermes_incomplete"),
          displayName: "Hermes incomplete",
          accentColor: undefined,
          environment: [],
          enabled: true,
          config: incompleteConfig,
        });
        const incompleteSnapshot = yield* incomplete.snapshot.getSnapshot;

        assert.equal(incompleteSnapshot.status, "warning");
        assert.equal(incompleteSnapshot.auth.status, "unauthenticated");
        assert.include(incompleteSnapshot.message, "HERMES_GATEWAY_TOKEN");
        assert.include(incompleteSnapshot.message, "attach to an existing Hermes Serve");

        const configuredConfig = yield* decodeHermesSettingsEffect({
          endpoint: "ws://127.0.0.1:49119/api/ws",
          profileKey: "default",
          managedServerEnabled: false,
        });
        const configured = yield* HermesDriver.create({
          instanceId: ProviderInstanceId.make("hermes_configured"),
          displayName: "Hermes configured",
          accentColor: undefined,
          environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "secret", sensitive: true }],
          enabled: true,
          config: configuredConfig,
        });
        const configuredSnapshot = yield* configured.snapshot.getSnapshot;

        assert.equal(configuredSnapshot.status, "warning");
        assert.equal(configuredSnapshot.auth.status, "unknown");
        assert.include(configuredSnapshot.message, "automatic startup is disabled");
        assert.isDefined(configured.hermesSessionCatalog);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});
