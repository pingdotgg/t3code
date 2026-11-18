import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  TRAEX_BRIDGE_CODEX_LAUNCH_ARGS,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TraexProviderRoutes from "../inference/TraexProviderRoutes.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEV_REPLAY_INSTANCE_ID,
  deriveProviderInstanceConfigMap,
  layerSettingsWatcher,
  seedDevReplayInstance,
} from "./ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistryMutator } from "./ProviderInstanceRegistryMutator.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap", () => {
  effectIt.effect(
    "discovers a verified Traex route without overwriting custom or disabled instances",
    () =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make("codex_traex");
        const driver = ProviderDriverKind.make("codex");
        const stock = { driver, config: { launchArgs: TRAEX_BRIDGE_CODEX_LAUNCH_ARGS } };
        const empty = deriveProviderInstanceConfigMap(settingsWith({}));
        const routes = yield* TraexProviderRoutes.TraexProviderRoutes;
        routes.bind(4123, "scoped-test-key", false);
        expect(routes.apply(empty)[id]).toBeUndefined();
        routes.setDiscovered(true);
        const effective = routes.apply(empty);
        expect(resolveProjectProviderInstanceEnabled(settingsWith({}), projectId, id)).toBe(true);
        expect(effective[id]?.config).toMatchObject({
          launchArgs: expect.stringContaining(
            "http://127.0.0.1:4123/api/inference/traex/resolve/v1",
          ),
        });
        expect(effective[id]?.environment).toContainEqual({
          name: "T3_TRAEX_ROUTE_KEY",
          sensitive: true,
          value: "scoped-test-key",
        });
        expect(effective[id]?.environment).toContainEqual({
          name: "T3CODE_CODEX_LAUNCH_ARGS",
          value: expect.stringContaining('env_key="T3_TRAEX_ROUTE_KEY"'),
          sensitive: false,
        });
        expect(effective[ProviderInstanceId.make("codex")]?.environment).toBeUndefined();
        expect(JSON.stringify(empty)).not.toContain("scoped-test-key");
        expect(empty[id]).toBeUndefined();
        const custom = { driver, config: { launchArgs: "--custom" } };
        const disabled = { ...stock, enabled: false };
        expect(routes.apply({ ...empty, [id]: custom })[id]).toEqual(custom);
        expect(routes.apply({ ...empty, [id]: disabled })[id]).toEqual(disabled);
        for (const overridden of [
          { ...stock, config: { ...stock.config, setupMode: "managed" } },
          { ...stock, config: { ...stock.config, inferenceEnabled: true } },
          {
            ...stock,
            environment: [
              { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "--custom", sensitive: false },
            ],
          },
        ]) {
          const configured = { ...empty, [instanceId]: overridden };
          expect(routes.apply(configured)).toEqual(configured);
        }
        const saved: ProviderInstanceConfigMap = { ...empty, [instanceId]: stock };
        const renamed = routes.apply(saved);
        expect(renamed[id]).toBeUndefined();
        expect(renamed[instanceId]?.config).toMatchObject({
          launchArgs: expect.stringContaining('env_key="T3_TRAEX_ROUTE_KEY"'),
        });
        expect(saved[instanceId]).toEqual(stock);
        routes.setDiscovered(false);
        expect(routes.apply(empty)[id]).toBeUndefined();
        expect(
          routes.apply(saved, {
            organization: "Example",
            lockedSettings: [],
            limits: { providers: { lockedInstanceFields: { [driver]: ["config.launchArgs"] } } },
          }),
        ).toEqual(saved);
      }).pipe(Effect.provide(TraexProviderRoutes.layer)),
  );

  it("overlays only T3's proxy runtime and preserves saved native selections", () => {
    const driver = ProviderDriverKind.make("codex");
    const id = ProviderInstanceId.make("codex");
    const native = {
      driver,
      config: {
        setupMode: "managed",
        homePath: "/native/home",
        shadowHomePath: "/native/account",
        launchArgs: "--native",
        customModels: ["gpt-native"],
      },
      environment: [{ name: "OPENAI_API_KEY", value: "native-key", sensitive: true }],
    };
    const route = {
      inferenceEnabled: true,
      inferenceHostId: "host",
      inferenceHostLabel: "",
      inferenceBaseUrl: "http://127.0.0.1:9876",
      inferenceKey: "proxy-key",
      inferenceModels: ["gpt-fixture"],
      inferenceHomePath: "/proxy/home",
    };
    const settings = settingsWith({
      providerInstances: {
        [id]: { ...native, config: { ...native.config, ...route } },
        [instanceId]: { driver, config: { setupMode: "cli" } },
        [ProviderInstanceId.make("codex_traex")]: {
          driver,
          config: { launchArgs: "-c 'model_provider=\"traex\"'" },
        },
      },
    });
    const before = structuredClone(settings);
    const enabled = deriveProviderInstanceConfigMap(settings);
    expect(enabled[instanceId]).toEqual(settings.providerInstances[instanceId]);
    expect(enabled[ProviderInstanceId.make("codex_traex")]).toBeDefined();
    expect(enabled[id]).toMatchObject({
      displayName: "Codex",
      config: {
        setupMode: "inference",
        homePath: "/proxy/home",
        shadowHomePath: "",
        customModels: ["gpt-fixture"],
      },
    });
    expect(enabled[id]?.environment).toContainEqual({
      name: "OPENAI_API_KEY",
      value: "",
      sensitive: false,
    });
    expect(enabled[id]?.environment).toContainEqual({
      name: "T3_INFERENCE_KEY",
      value: "proxy-key",
      sensitive: true,
    });
    expect(settings).toEqual(before);
    const disabled = deriveProviderInstanceConfigMap({
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [id]: { ...native, config: { ...native.config, ...route, inferenceEnabled: false } },
      },
    });
    expect(disabled[id]).toMatchObject(native);
    expect(disabled[instanceId]).toEqual(settings.providerInstances[instanceId]);
    for (const inferenceKey of ["", undefined]) {
      const invalid = deriveProviderInstanceConfigMap({
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [id]: { ...native, config: { ...native.config, ...route, inferenceKey } },
        },
      });
      expect(invalid[id]?.enabled).toBe(false);
      expect(invalid[instanceId]).toEqual(settings.providerInstances[instanceId]);
    }
  });

  it("adds the pool to OpenCode beside its own logins and other instances", () => {
    const driver = ProviderDriverKind.make("opencode");
    const id = ProviderInstanceId.make("opencode");
    const other = ProviderInstanceId.make("opencode_work");
    const settings = settingsWith({
      providerInstances: {
        [id]: {
          driver,
          displayName: "My OpenCode",
          config: {
            inferenceEnabled: true,
            inferenceHostId: "host",
            inferenceHostLabel: "Office",
            inferenceBaseUrl: "http://127.0.0.1:9876",
            inferenceKey: "proxy-key",
            inferenceModels: ["grok-fixture"],
            inferenceHomePath: "/proxy/home",
          },
          environment: [
            { name: "OPENCODE_CONFIG_CONTENT", value: '{"theme":"mine"}', sensitive: false },
          ],
        },
        [other]: { driver },
      },
    });
    const hostEnvironment = {
      OPENCODE_CONFIG_CONTENT: '{"theme":"inherited","provider":{"host":{}}}',
    };
    const merged = deriveProviderInstanceConfigMap(settings, hostEnvironment);
    expect(merged[other]).toBeDefined();
    expect(merged[id]?.displayName).toBe("My OpenCode");
    const environment = merged[id]?.environment ?? [];
    expect(environment).toContainEqual({
      name: "T3_INFERENCE_KEY",
      value: "proxy-key",
      sensitive: true,
    });
    const contents = environment.filter((entry) => entry.name === "OPENCODE_CONFIG_CONTENT");
    expect(contents).toHaveLength(1);
    expect(JSON.parse(String(contents[0]?.value))).toMatchObject({
      theme: "mine",
      provider: { t3proxy: { models: { "grok-fixture": { name: "grok-fixture" } } } },
    });
    expect(JSON.parse(String(contents[0]?.value)).provider).not.toHaveProperty("host");
    const inherited = deriveProviderInstanceConfigMap(
      {
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [id]: { ...settings.providerInstances[id]!, environment: [] },
        },
      },
      hostEnvironment,
    );
    expect(
      JSON.parse(
        String(
          inherited[id]?.environment?.find((entry) => entry.name === "OPENCODE_CONFIG_CONTENT")
            ?.value,
        ),
      ),
    ).toMatchObject({
      theme: "inherited",
      provider: { host: {}, t3proxy: { models: { "grok-fixture": { name: "grok-fixture" } } } },
    });
    for (const variable of [
      { name: "OPENCODE_CONFIG_CONTENT", value: '{"theme":', sensitive: false },
      { name: "OPENCODE_CONFIG_CONTENT", value: "", sensitive: true, valueRedacted: true },
    ]) {
      const native = { ...settings.providerInstances[id]!, environment: [variable] };
      const invalid = deriveProviderInstanceConfigMap(
        {
          ...settings,
          providerInstances: { ...settings.providerInstances, [id]: native },
        },
        hostEnvironment,
      );
      expect(invalid[id]).toEqual(native);
    }
  });

  it("adds Pi proxy models without replacing native settings, credentials, or other instances", () => {
    const id = ProviderInstanceId.make("pi");
    const other = ProviderInstanceId.make("pi_work");
    const native = {
      driver: ProviderDriverKind.make("pi"),
      displayName: "My Pi",
      config: {
        launchArgs: "--provider native --model native-model",
        customModels: ["native/native-model"],
        inferenceEnabled: true,
        inferenceHostId: "host",
        inferenceHostLabel: "Office",
        inferenceBaseUrl: "http://127.0.0.1:9876/api/inference/linked/host",
        inferenceKey: "proxy-key",
        inferenceModels: ["grok-fixture"],
        inferenceHomePath: "/proxy/home",
      },
      environment: [
        { name: "PI_CODING_AGENT_DIR", value: "/native/pi", sensitive: false },
        { name: "OPENAI_API_KEY", value: "native-key", sensitive: true },
      ],
    };
    const settings = settingsWith({
      providerInstances: { [id]: native, [other]: { driver: native.driver } },
    });
    const before = structuredClone(settings);
    const active = deriveProviderInstanceConfigMap(settings);
    expect(active[id]).toMatchObject({
      driver: native.driver,
      displayName: native.displayName,
      config: native.config,
    });
    expect(active[other]).toEqual(settings.providerInstances[other]);
    expect(active[id]?.environment).toEqual([
      ...native.environment,
      { name: "T3_INFERENCE_KEY", value: "proxy-key", sensitive: true },
      {
        name: "T3_PI_INFERENCE_CONFIG",
        value: JSON.stringify({
          baseUrl: "http://127.0.0.1:9876/api/inference/linked/host/v1",
          models: ["grok-fixture"],
        }),
        sensitive: false,
      },
    ]);
    expect(settings).toEqual(before);
    const disabled = { ...native, config: { ...native.config, inferenceEnabled: false } };
    const restored = deriveProviderInstanceConfigMap({
      ...settings,
      providerInstances: { ...settings.providerInstances, [id]: disabled },
    });
    expect(restored[id]).toEqual(disabled);
    expect(restored[other]).toEqual(settings.providerInstances[other]);
  });

  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it.each(["codex", "claudeAgent"] as const)(
    "keeps incomplete %s proxy routing disabled even when a project enables the provider",
    (kind) => {
      const id = ProviderInstanceId.make(kind);
      const settings = settingsWith({
        providerInstances: {
          [id]: {
            driver: ProviderDriverKind.make(kind),
            config: { setupMode: "cli", inferenceEnabled: true },
          },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [id]: { enabled: true } } },
        },
      });

      expect(deriveProviderInstanceConfigMap(settings)[id]?.enabled).toBe(false);
    },
  );

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });
});

describe("seedDevReplayInstance", () => {
  const seed = (devUrl: URL | undefined) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* seedDevReplayInstance().pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, devUrl }),
      );
      const settings = yield* ServerSettingsService;
      return (yield* settings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-replay-seed-" }),
          ServerSettingsService.layerTest({
            providerInstances: {
              [DEV_REPLAY_INSTANCE_ID]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName: "My replay",
                enabled: false,
                config: { source: "local", commandPath: "/old/node" },
              },
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

  effectIt.effect("leaves settings alone outside dev", () =>
    seed(undefined).pipe(
      Effect.map((instance) =>
        expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
      ),
    ),
  );

  effectIt.effect("points a dev server at the replay agent and keeps user edits", () =>
    seed(new URL("http://localhost:5733")).pipe(
      Effect.map((instance) => {
        expect(instance?.displayName).toBe("My replay");
        expect(instance?.enabled).toBe(false);
        expect(instance?.config).toMatchObject({
          source: "local",
          commandArgs: [expect.stringMatching(/scripts[/\\]dev-replay-agent\.ts$/)],
        });
      }),
    ),
  );
});

describe("layerSettingsWatcher", () => {
  const provider = (label: string) => ({
    [SecretProviderId.make("personal")]: {
      kind: SecretProviderKind.make("one_password"),
      label,
      config: { account: "my" },
    },
  });

  const watch = (initial: ServerSettings | undefined) =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ServerSettings>();
      const reconciled = yield* Queue.unbounded<void>();
      let reloads = 0;
      const mutator = Layer.succeed(ProviderInstanceRegistryMutator, {
        reconcile: () => Queue.offer(reconciled, undefined),
        reloadSecrets: () => Effect.sync(() => void reloads++),
        rebuild: () => Effect.void,
        applySecret: () => Effect.succeed([]),
      });
      yield* Layer.build(
        layerSettingsWatcher(Stream.fromQueue(changes), initial).pipe(Layer.provide(mutator)),
      );
      return {
        reloads: () => reloads,
        // Changes run one at a time, so the repeat's reconcile means the first one's reload decision is done.
        change: (settings: ServerSettings) =>
          Queue.offerAll(changes, [settings, settings]).pipe(
            Effect.andThen(Queue.take(reconciled)),
            Effect.andThen(Queue.take(reconciled)),
          ),
      };
    });

  effectIt.effect(
    "retries unreadable secrets when a secret provider changes, not when it is renamed",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const { reloads, change } = yield* watch(yield* settings.getSettings);

        yield* change(yield* settings.updateSettings({ secretProviders: provider("Personal") }));
        expect(reloads()).toBe(1);

        // A label is not read by any vault, so renaming a provider retries nothing.
        yield* change(yield* settings.updateSettings({ secretProviders: provider("Renamed") }));
        expect(reloads()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest())),
  );

  effectIt.effect(
    "compares a change queued during startup with the settings the registry started from",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const started = yield* settings.getSettings;
        const saved = yield* settings.updateSettings({ secretProviders: provider("Personal") });
        const { reloads, change } = yield* watch(started);

        yield* change(saved);

        expect(reloads()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest())),
  );
});
