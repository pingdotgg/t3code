import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
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
