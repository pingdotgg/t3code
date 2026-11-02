import { describe, expect, it } from "@effect/vitest";
import {
  AntigravitySettings,
  CodexSettings,
  isProviderAccountTransferError,
  PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS,
  PROVIDER_ACCOUNT_SECRETS_MAX,
  ProviderAccountExport as ProviderAccountExportSchema,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  type ProviderAccountExport,
} from "@t3tools/contracts";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProviderAccountTransfer from "./ProviderAccountTransfer.ts";
import * as ProviderAuthService from "./ProviderAuthService.ts";

const codex = ProviderDriverKind.make("codex");
const antigravity = ProviderDriverKind.make("antigravity");
const cursor = ProviderDriverKind.make("cursor");
const workCodex = ProviderInstanceId.make("codex_work");
const defaultCodex = ProviderInstanceId.make("codex");
const defaultCursor = ProviderInstanceId.make("cursor");
const gemini = ProviderInstanceId.make("antigravity_gemini");

const decodeExport = Schema.decodeSync(ProviderAccountExportSchema);

type Driver = ProviderAccountTransfer.ProviderDriverDefinition;
const driver = (
  driverKind: ProviderDriverKind,
  configSchema: Driver["configSchema"],
  metadata: Partial<Driver["metadata"]> = {},
): Driver => ({ driverKind, configSchema, metadata: { displayName: driverKind, ...metadata } });
const builtIn: ReadonlyArray<Driver> = [
  driver(codex, CodexSettings),
  driver(antigravity, AntigravitySettings),
  driver(cursor, cursorClient.settingsSchema),
  driver(fxClient.driverKind, fxClient.settingsSchema),
];

interface EnvironmentInput {
  readonly settings?: Parameters<typeof Settings.layerTest>[0];
  readonly staticCredential?: { readonly name: string; readonly value: string };
  readonly drivers?: ReadonlyArray<Driver>;
}

const makeEnvironment = (input: EnvironmentInput = {}) =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const transfer = yield* ProviderAccountTransfer.ProviderAccountTransfer;
    return { settings, transfer };
  }).pipe(
    Effect.provide(
      Layer.effect(
        ProviderAccountTransfer.ProviderAccountTransfer,
        ProviderAccountTransfer.makeProviderAccountTransfer(input.drivers ?? builtIn),
      ).pipe(
        Layer.provideMerge(Settings.layerTest(input.settings)),
        Layer.provide(
          Layer.mock(ProviderAuthService.ProviderAuthService)({
            readStaticCredential: () =>
              Effect.succeed(
                input.staticCredential === undefined
                  ? Option.none()
                  : Option.some(input.staticCredential),
              ),
          }),
        ),
      ),
    ),
  );

const sourceCodex = {
  driver: codex,
  displayName: "Work Codex",
  config: {
    setupMode: "cli",
    binaryPath: "/opt/codex/bin/codex",
    homePath: "/Users/a/.codex",
    launchArgs: "--profile work",
  },
  environment: [
    { name: "OPENAI_API_KEY", value: "sk-source", sensitive: true },
    { name: "CODEX_HOME", value: "/Users/a/.codex-work", sensitive: false },
    { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/Users/a/gcp.json", sensitive: false },
    { name: "OPENAI_BASE_URL", value: "https://proxy.example.test", sensitive: false },
  ],
};
const sourceSettings = { providerInstances: { [workCodex]: sourceCodex } };
const secretBacked = (reference: string) => ({
  name: "OPENAI_ORG_TOKEN",
  value: { provider: SecretProviderId.make("onepassword"), reference },
  sensitive: true,
});

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      isProviderAccountTransferError(error) ? error.reason : `unexpected: ${String(error)}`,
    ),
  );

describe("ProviderAccountTransfer", () => {
  it.effect("transfers fx configuration while keeping binary paths local", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("fx_work");
      const a = yield* makeEnvironment({
        settings: {
          providerInstances: {
            [instanceId]: {
              driver: fxClient.driverKind,
              enabled: true,
              config: {
                enabled: true,
                binaryPath: "/a/bin/fx",
                customModels: ["team-model"],
              },
            },
          },
        },
      });
      const b = yield* makeEnvironment();
      const exported = yield* a.transfer.exportAccount(instanceId);
      expect(exported.instance.enabled).toBe(true);
      expect(exported.instance.config).toEqual({ customModels: ["team-model"] });
      expect(exported.omitted).toContainEqual({
        setting: { _tag: "ConfigField", field: "binaryPath" },
        reason: "machine-local",
      });
      yield* b.transfer.importAccount(exported);
      expect((yield* b.settings.getSettings).providerInstances[instanceId]?.config).toEqual(
        exported.instance.config,
      );
    }),
  );

  it.effect("exports portable settings and secrets and leaves machine-local settings behind", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({
        settings: {
          providerInstances: {
            [workCodex]: {
              ...sourceCodex,
              environment: [...sourceCodex.environment, secretBacked("op://work/org")],
            },
          },
        },
      });
      const exported = yield* a.transfer.exportAccount(workCodex);
      expect(exported.instance).toEqual({
        driver: codex,
        displayName: "Work Codex",
        enabled: true,
        config: { setupMode: "cli", launchArgs: "--profile work" },
        environment: [{ name: "OPENAI_BASE_URL", value: "https://proxy.example.test" }],
      });
      expect(exported.secrets).toEqual([
        { _tag: "EnvironmentVariable", name: "OPENAI_API_KEY", value: "sk-source" },
      ]);
      expect(exported.omitted).toEqual([
        { setting: { _tag: "ConfigField", field: "binaryPath" }, reason: "machine-local" },
        { setting: { _tag: "ConfigField", field: "homePath" }, reason: "machine-local" },
        { setting: { _tag: "EnvironmentVariable", name: "CODEX_HOME" }, reason: "machine-local" },
        {
          setting: { _tag: "EnvironmentVariable", name: "GOOGLE_APPLICATION_CREDENTIALS" },
          reason: "machine-local",
        },
        {
          setting: { _tag: "EnvironmentVariable", name: "OPENAI_ORG_TOKEN" },
          reason: "machine-local",
        },
      ]);
    }),
  );

  it.effect("exports an implicit default instance and refuses an unknown id", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment();
      const exported = yield* a.transfer.exportAccount(defaultCursor);
      expect(exported.instance).toMatchObject({ driver: cursor, config: {}, environment: [] });
      expect(yield* failure(a.transfer.exportAccount(ProviderInstanceId.make("nope")))).toBe(
        "instance-not-found",
      );
    }),
  );

  it.effect("creates the account on a destination that lacks it, secrets included", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({ settings: sourceSettings });
      const b = yield* makeEnvironment();
      const exported = yield* a.transfer.exportAccount(workCodex);
      const result = yield* b.transfer.importAccount(exported);
      expect(result).toEqual({
        instanceId: workCodex,
        change: "created",
        omitted: exported.omitted,
      });
      expect((yield* b.settings.getSettings).providerInstances[workCodex]).toEqual({
        driver: codex,
        displayName: "Work Codex",
        enabled: true,
        config: { setupMode: "cli", launchArgs: "--profile work" },
        environment: [
          { name: "OPENAI_BASE_URL", value: "https://proxy.example.test", sensitive: false },
          { name: "OPENAI_API_KEY", value: "sk-source", sensitive: true },
        ],
      });
    }),
  );

  it.effect("updates an existing copy but keeps this machine's paths and enabled flag", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({ settings: sourceSettings });
      const b = yield* makeEnvironment({
        settings: {
          providerInstances: {
            [workCodex]: {
              driver: codex,
              enabled: false,
              config: {
                setupMode: "managed",
                binaryPath: "/b/codex",
                homePath: "/b/.codex",
                launchArgs: "stale",
              },
              environment: [
                { name: "CODEX_HOME", value: "/b/.codex-work", sensitive: false },
                { name: "OPENAI_API_KEY", value: "sk-old", sensitive: true },
                { name: "ONLY_ON_B", value: "mirrored-away", sensitive: true },
                secretBacked("op://b/org"),
              ],
            },
          },
        },
      });
      const result = yield* b.transfer.importAccount(yield* a.transfer.exportAccount(workCodex));
      expect(result.change).toBe("updated");
      expect((yield* b.settings.getSettings).providerInstances[workCodex]).toEqual({
        driver: codex,
        displayName: "Work Codex",
        enabled: false,
        config: {
          setupMode: "cli",
          launchArgs: "--profile work",
          binaryPath: "/b/codex",
          homePath: "/b/.codex",
        },
        environment: [
          { name: "CODEX_HOME", value: "/b/.codex-work", sensitive: false },
          secretBacked("op://b/org"),
          { name: "OPENAI_BASE_URL", value: "https://proxy.example.test", sensitive: false },
          { name: "OPENAI_API_KEY", value: "sk-source", sensitive: true },
        ],
      });
    }),
  );

  it.effect("converges: importing the same export again changes nothing", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({ settings: sourceSettings });
      const b = yield* makeEnvironment();
      const exported = yield* a.transfer.exportAccount(workCodex);
      yield* b.transfer.importAccount(exported);
      const once = yield* b.settings.getSettings;
      const again = yield* b.transfer.importAccount(exported);
      expect(again.change).toBe("updated");
      expect(yield* b.settings.getSettings).toEqual(once);
    }),
  );

  it.effect("treats an implicit default instance on the destination as existing", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({
        settings: {
          providerInstances: { [defaultCodex]: { driver: codex, config: { launchArgs: "-x" } } },
        },
      });
      const b = yield* makeEnvironment();
      const result = yield* b.transfer.importAccount(yield* a.transfer.exportAccount(defaultCodex));
      expect(result.change).toBe("updated");
      expect((yield* b.settings.getSettings).providerInstances[defaultCodex]?.config).toEqual({
        launchArgs: "-x",
      });
    }),
  );

  it.effect("leaves an implicit default instance on the destination enabled by default", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({
        settings: { providerInstances: { [defaultCodex]: { driver: codex, enabled: false } } },
      });
      const b = yield* makeEnvironment();
      const exported = yield* a.transfer.exportAccount(defaultCodex);
      expect(exported.instance.enabled).toBe(false);
      yield* b.transfer.importAccount(exported);
      const stored = (yield* b.settings.getSettings).providerInstances[defaultCodex];
      expect(stored).toBeDefined();
      expect(stored).not.toHaveProperty("enabled");
    }),
  );

  it.effect("moves a secret config field through its slot and stores it under that field", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({
        settings: {
          providerInstances: {
            [gemini]: {
              driver: antigravity,
              config: { authMethod: "gemini-api-key", apiKey: "gm-secret", binaryPath: "/a/ag" },
            },
          },
        },
      });
      const b = yield* makeEnvironment();
      const exported = yield* a.transfer.exportAccount(gemini);
      expect(exported.instance.config).toEqual({ authMethod: "gemini-api-key" });
      expect(exported.secrets).toEqual([
        { _tag: "ConfigField", field: "apiKey", value: "gm-secret" },
      ]);
      yield* b.transfer.importAccount(exported);
      expect((yield* b.settings.getSettings).providerInstances[gemini]?.config).toEqual({
        authMethod: "gemini-api-key",
        apiKey: "gm-secret",
      });
    }),
  );

  it.effect("reports a secret the source declares but does not hold", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({
        settings: {
          providerInstances: {
            [gemini]: {
              driver: antigravity,
              config: { authMethod: "gemini-api-key", apiKey: "" },
              environment: [{ name: "GEMINI_API_KEY", value: "", sensitive: true }],
            },
          },
        },
      });
      const exported = yield* a.transfer.exportAccount(gemini);
      expect(exported.secrets).toEqual([]);
      expect(exported.instance.config).toEqual({ authMethod: "gemini-api-key" });
      expect(exported.omitted).toEqual([
        { setting: { _tag: "ConfigField", field: "apiKey" }, reason: "missing-on-source" },
        {
          setting: { _tag: "EnvironmentVariable", name: "GEMINI_API_KEY" },
          reason: "missing-on-source",
        },
      ]);
    }),
  );

  it.effect("leaves behind a secret past the transfer limits and reports it", () =>
    Effect.gen(function* () {
      const oversized = "x".repeat(PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS + 1);
      const fits = "y".repeat(PROVIDER_ACCOUNT_SECRET_VALUE_MAX_CHARS);
      const crowded = Array.from({ length: PROVIDER_ACCOUNT_SECRETS_MAX + 1 }, (_, index) => ({
        name: `KEY_${index}`,
        value: `value-${index}`,
        sensitive: true,
      }));
      const a = yield* makeEnvironment({
        settings: {
          providerInstances: {
            [gemini]: {
              driver: antigravity,
              config: { authMethod: "gemini-api-key", apiKey: oversized },
              environment: [{ name: "GEMINI_API_KEY", value: fits, sensitive: true }],
            },
            [workCodex]: { driver: codex, environment: crowded },
          },
        },
      });
      const large = yield* a.transfer.exportAccount(gemini);
      expect(large.secrets).toEqual([
        { _tag: "EnvironmentVariable", name: "GEMINI_API_KEY", value: fits },
      ]);
      expect(large.omitted).toEqual([
        { setting: { _tag: "ConfigField", field: "apiKey" }, reason: "too-large" },
      ]);

      const many = yield* a.transfer.exportAccount(workCodex);
      expect(many.secrets).toHaveLength(PROVIDER_ACCOUNT_SECRETS_MAX);
      expect(many.omitted).toEqual([
        {
          setting: { _tag: "EnvironmentVariable", name: `KEY_${PROVIDER_ACCOUNT_SECRETS_MAX}` },
          reason: "too-large",
        },
      ]);
      for (const exported of [large, many]) expect(() => decodeExport(exported)).not.toThrow();
    }),
  );

  it.effect.each(["missing-on-source", "too-large"] as const)(
    "keeps the destination's secret when the source sends none (%s)",
    (reason) =>
      Effect.gen(function* () {
        const b = yield* makeEnvironment({
          settings: {
            providerInstances: {
              [gemini]: {
                driver: antigravity,
                config: { authMethod: "gemini-api-key", apiKey: "b-key" },
                environment: [{ name: "GEMINI_API_KEY", value: "b-env", sensitive: true }],
              },
            },
          },
        });
        yield* b.transfer.importAccount({
          instanceId: gemini,
          instance: {
            driver: antigravity,
            config: { authMethod: "gemini-api-key" },
            environment: [],
          },
          secrets: [],
          omitted: [
            { setting: { _tag: "ConfigField", field: "apiKey" }, reason },
            {
              setting: { _tag: "EnvironmentVariable", name: "GEMINI_API_KEY" },
              reason,
            },
          ],
        });
        const stored = (yield* b.settings.getSettings).providerInstances[gemini];
        expect(stored?.config).toEqual({ authMethod: "gemini-api-key", apiKey: "b-key" });
        expect(stored?.environment).toEqual([
          { name: "GEMINI_API_KEY", value: "b-env", sensitive: true },
        ]);
      }),
  );

  it.effect("omits a secret field this build does not treat as secret instead of writing it", () =>
    Effect.gen(function* () {
      const b = yield* makeEnvironment();
      const account: ProviderAccountExport = {
        instanceId: workCodex,
        instance: { driver: codex, config: {}, environment: [] },
        secrets: [{ _tag: "ConfigField", field: "serverPassword", value: "hunter2" }],
        omitted: [],
      };
      const result = yield* b.transfer.importAccount(account);
      expect(result.omitted).toEqual([
        { setting: { _tag: "ConfigField", field: "serverPassword" }, reason: "unsupported-here" },
      ]);
      expect(JSON.stringify(yield* b.settings.getSettings)).not.toContain("hunter2");
    }),
  );

  it.effect("refuses a driver this build lacks on either end", () =>
    Effect.gen(function* () {
      const unknown = ProviderDriverKind.make("nope");
      const id = ProviderInstanceId.make("nope_1");
      const a = yield* makeEnvironment({
        settings: { providerInstances: { [id]: { driver: unknown } } },
      });
      expect(yield* failure(a.transfer.exportAccount(id))).toBe("driver-unavailable");
      const b = yield* makeEnvironment();
      const account: ProviderAccountExport = {
        instanceId: id,
        instance: { driver: unknown, config: {}, environment: [] },
        secrets: [],
        omitted: [],
      };
      expect(yield* failure(b.transfer.importAccount(account))).toBe("driver-unavailable");
      expect((yield* b.settings.getSettings).providerInstances[id]).toBeUndefined();
    }),
  );

  it.effect("refuses an id the destination uses for another driver and writes nothing", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({ settings: sourceSettings });
      const existing = { driver: antigravity, config: { authMethod: "oauth-personal" } };
      const b = yield* makeEnvironment({
        settings: { providerInstances: { [workCodex]: existing } },
      });
      const exported = yield* a.transfer.exportAccount(workCodex);
      expect(yield* failure(b.transfer.importAccount(exported))).toBe("instance-id-conflict");
      expect((yield* b.settings.getSettings).providerInstances[workCodex]).toEqual(existing);
    }),
  );

  it.effect("refuses a second instance of a driver that allows only one", () =>
    Effect.gen(function* () {
      const a = yield* makeEnvironment({ settings: sourceSettings });
      const b = yield* makeEnvironment({
        drivers: [driver(codex, CodexSettings, { supportsMultipleInstances: false })],
      });
      const exported = yield* a.transfer.exportAccount(workCodex);
      expect(yield* failure(b.transfer.importAccount(exported))).toBe("single-instance");
      expect((yield* b.settings.getSettings).providerInstances[workCodex]).toBeUndefined();
      const onDefault = yield* b.transfer.importAccount({ ...exported, instanceId: defaultCodex });
      expect(onDefault.change).toBe("updated");
    }),
  );

  it.effect("rejects settings this build's schema cannot decode before writing", () =>
    Effect.gen(function* () {
      const b = yield* makeEnvironment();
      const account: ProviderAccountExport = {
        instanceId: gemini,
        instance: {
          driver: antigravity,
          config: { authMethod: "carrier-pigeon" },
          environment: [],
        },
        secrets: [],
        omitted: [],
      };
      expect(yield* failure(b.transfer.importAccount(account))).toBe("invalid-config");
      expect((yield* b.settings.getSettings).providerInstances[gemini]).toBeUndefined();
    }),
  );

  it.effect("exports a Cursor sign-in as CURSOR_API_KEY unless the variable is already set", () =>
    Effect.gen(function* () {
      const staticCredential = { name: "CURSOR_API_KEY", value: "key-from-sign-in" };
      const signedIn = yield* makeEnvironment({ staticCredential });
      expect((yield* signedIn.transfer.exportAccount(defaultCursor)).secrets).toEqual([
        { _tag: "EnvironmentVariable", name: "CURSOR_API_KEY", value: "key-from-sign-in" },
      ]);
      const configured = yield* makeEnvironment({
        staticCredential,
        settings: {
          providerInstances: {
            [defaultCursor]: {
              driver: cursor,
              environment: [{ name: "CURSOR_API_KEY", value: "configured-key", sensitive: true }],
            },
          },
        },
      });
      expect((yield* configured.transfer.exportAccount(defaultCursor)).secrets).toEqual([
        { _tag: "EnvironmentVariable", name: "CURSOR_API_KEY", value: "configured-key" },
      ]);
    }),
  );
});

const encodeName = (value: string) => Buffer.from(value, "utf8").toString("base64url");

describe("ProviderAccountTransfer on the real settings layer", () => {
  it.effect("keeps a destination secret the source reports as missing", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      const transfer = yield* ProviderAccountTransfer.ProviderAccountTransfer;
      yield* settings.updateSettings({
        providerInstances: {
          [gemini]: {
            driver: antigravity,
            config: { authMethod: "gemini-api-key", apiKey: "b-key" },
            environment: [{ name: "GEMINI_API_KEY", value: "b-env", sensitive: true }],
          },
        },
      });
      const before = yield* settings.getSettings;
      const configSecret = `provider-config-${encodeName(gemini)}-${encodeName(antigravity)}-${encodeName("apiKey")}`;
      const envSecret = `provider-env-${encodeName(gemini)}-${encodeName("GEMINI_API_KEY")}`;
      expect(Option.isSome(yield* store.get(configSecret))).toBe(true);

      yield* transfer.importAccount({
        instanceId: gemini,
        instance: {
          driver: antigravity,
          config: { authMethod: "gemini-api-key" },
          environment: [],
        },
        secrets: [],
        omitted: [
          { setting: { _tag: "ConfigField", field: "apiKey" }, reason: "missing-on-source" },
          {
            setting: { _tag: "EnvironmentVariable", name: "GEMINI_API_KEY" },
            reason: "missing-on-source",
          },
        ],
      });

      const decode = (name: string) =>
        store.get(name).pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));
      expect(yield* decode(configSecret)).toEqual(Option.some("b-key"));
      expect(yield* decode(envSecret)).toEqual(Option.some("b-env"));
      expect(yield* settings.getSettings).toEqual(before);
    }).pipe(
      Effect.provide(
        Layer.effect(
          ProviderAccountTransfer.ProviderAccountTransfer,
          ProviderAccountTransfer.makeProviderAccountTransfer(builtIn),
        ).pipe(
          Layer.provideMerge(Settings.layer),
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3code-account-transfer-test-" }),
            ),
          ),
          Layer.provide(
            Layer.mock(ProviderAuthService.ProviderAuthService)({
              readStaticCredential: () => Effect.succeedNone,
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
