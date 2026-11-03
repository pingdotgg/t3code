import {
  AwsBedrockSettings,
  CloudflareSettings,
  OllamaSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  TextGenerationError,
  ZedSettings,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

const makeUnsupportedOrchestrationAdapter = (
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  driver,
  instanceId,
  getCapabilities: () =>
    Effect.succeed({
      supportsModelSwitchInSession: false,
      canReadThreadSnapshot: false,
      supportsForkThread: false,
      supportsRollbackThread: false,
      supportsSteerTurn: false,
    } as unknown as OrchestrationV2ProviderCapabilities),
  planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
  openSession: (input) =>
    Effect.fail(
      new ProviderAdapterOpenSessionError({
        driver,
        providerSessionId: input.providerSessionId,
        cause: new Error(`${driver} does not support live orchestration sessions.`),
      }),
    ),
});

const makeUnsupportedTextGeneration = (driver: ProviderDriverKind): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${driver} does not provide application text generation.`,
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

export type StandaloneDriverEnv =
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | HostProcess.HomeDirectory
  | HostProcess.Platform;

export interface StandaloneProbeResult {
  readonly installed: boolean;
  readonly status: "ready" | "warning" | "error";
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown";
    readonly label?: string;
    readonly email?: string;
  };
  readonly message?: string;
  readonly version?: string | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

interface StandaloneDriverOptions<Config extends { enabled?: boolean }> {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly probe: (
    config: Config,
    env: NodeJS.ProcessEnv,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    httpClient: HttpClient.HttpClient,
  ) => Effect.Effect<StandaloneProbeResult>;
}

function createStandaloneDriver<Config extends { enabled?: boolean }>(
  options: StandaloneDriverOptions<Config>,
): ProviderDriver<Config, StandaloneDriverEnv> {
  const decodeConfig = Schema.decodeSync(options.configSchema);

  return {
    driverKind: options.driverKind,
    metadata: {
      displayName: options.displayName,
      supportsMultipleInstances: true,
    },
    configSchema: options.configSchema,
    defaultConfig: (): Config => decodeConfig({} as any) as Config,
    create: Effect.fn("StandaloneDriver.create")(function* ({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } as Config;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: options.driverKind,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: options.driverKind,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const checkProvider: Effect.Effect<ServerProvider> = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!enabled) {
          const disabledDraft = buildServerProvider({
            driver: options.driverKind,
            presentation: { displayName: options.displayName },
            enabled: false,
            checkedAt,
            models: [],
            probe: {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: `${options.displayName} is disabled in settings.`,
            },
          });
          return stampIdentity(disabledDraft);
        }

        const probed = yield* options
          .probe(effectiveConfig, processEnv, spawner, httpClient)
          .pipe(
            Effect.orElseSucceed(() => ({
              installed: false,
              status: "warning" as const,
              auth: { status: "unknown" as const, label: options.displayName },
              message: `Could not verify ${options.displayName} status.`,
              version: null,
              models: [] as ReadonlyArray<ServerProviderModel>,
            })),
          );

        const status =
          probed.status === "ready" ? ("warning" as const) : probed.status;
        const message =
          probed.status === "ready"
            ? `${options.displayName} is connected, but live orchestration sessions are not supported yet.`
            : probed.message;

        const draft: ServerProviderDraft = buildServerProvider({
          driver: options.driverKind,
          presentation: { displayName: options.displayName },
          enabled: true,
          checkedAt,
          models: [],
          probe: {
            installed: probed.installed,
            version: probed.version ?? null,
            status,
            auth: probed.auth,
            ...(message ? { message } : {}),
          },
        });

        return stampIdentity(draft);
      });

      const managed = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: options.driverKind,
              packageName: null,
            }),
          ),
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => checkProvider,
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: options.driverKind,
              instanceId,
              detail: `Failed to build ${options.displayName} snapshot.`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: options.driverKind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: managed,
        orchestrationAdapter: makeUnsupportedOrchestrationAdapter(options.driverKind, instanceId),
        textGeneration: makeUnsupportedTextGeneration(options.driverKind),
      } satisfies ProviderInstance;
    }),
  };
}

const probeOllama = Effect.fn("probeOllama")(function* (
  config: OllamaSettings,
  env: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  httpClient: HttpClient.HttpClient,
): Effect.fn.Return<StandaloneProbeResult> {
  const configuredEndpoint = config.apiEndpoint?.trim();
  const endpoint =
    configuredEndpoint &&
    configuredEndpoint.length > 0 &&
    configuredEndpoint !== "http://localhost:11434"
      ? configuredEndpoint
      : env.OLLAMA_HOST?.trim() || configuredEndpoint || "http://localhost:11434";
  const trimmedEndpoint = endpoint.replace(/\/+$/, "");
  const builtInModels: ReadonlyArray<ServerProviderModel> = [
    { slug: "llama3.3", name: "Llama 3.3", isDefault: true, isCustom: false, capabilities: null },
    { slug: "deepseek-r1", name: "DeepSeek R1", isDefault: false, isCustom: false, capabilities: null },
    { slug: "qwen2.5-coder", name: "Qwen 2.5 Coder", isDefault: false, isCustom: false, capabilities: null },
  ];
  const models = providerModelsFromSettings(builtInModels, config.customModels, null);

  // Ping Ollama version endpoint
  const reachable = yield* httpClient
    .get(`${trimmedEndpoint}/api/version`)
    .pipe(
      Effect.timeout("2 seconds"),
      Effect.map((res: { readonly status: number }) => res.status === 200),
      Effect.orElseSucceed(() => false),
    );

  if (reachable) {
    return {
      installed: true,
      status: "ready",
      auth: { status: "authenticated", label: "Ollama" },
      models,
    };
  }

  // Try CLI check if HTTP ping failed
  const cliCheck = yield* spawner
    .exitCode(ChildProcess.make("ollama", ["--version"]))
    .pipe(
      Effect.map((code) => Number(code) === 0),
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => false),
    );

  if (cliCheck) {
    return {
      installed: true,
      status: "warning",
      auth: { status: "unknown", label: "Ollama" },
      message: `Ollama CLI is installed, but the server is not responding at ${trimmedEndpoint}.`,
      models,
    };
  }

  return {
    installed: false,
    status: "warning",
    auth: { status: "unknown", label: "Ollama" },
    message: "Ollama server is not running on configured endpoint.",
    models,
  };
});

export const OllamaDriver: ProviderDriver<OllamaSettings, StandaloneDriverEnv> =
  createStandaloneDriver({
    driverKind: ProviderDriverKind.make("ollama"),
    displayName: "Ollama",
    configSchema: OllamaSettings,
    probe: probeOllama,
  });

const probeZed = Effect.fn("probeZed")(function* (
  config: ZedSettings,
  _env: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.fn.Return<StandaloneProbeResult> {
  const binary = config.binaryPath || "zed";
  const builtInModels: ReadonlyArray<ServerProviderModel> = [
    { slug: "default", name: "Zed Default", isDefault: true, isCustom: false, capabilities: null },
  ];
  const models = providerModelsFromSettings(builtInModels, config.customModels, null);

  const cliCheck = yield* spawner
    .exitCode(ChildProcess.make(binary, ["--version"]))
    .pipe(
      Effect.map((code) => Number(code) === 0),
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => false),
    );

  if (cliCheck) {
    return {
      installed: true,
      status: "ready",
      auth: { status: "authenticated", label: "Zed" },
      models,
    };
  }

  return {
    installed: false,
    status: "warning",
    auth: { status: "unknown", label: "Zed" },
    message: "Zed binary was not found on PATH.",
    models,
  };
});

export const ZedDriver: ProviderDriver<ZedSettings, StandaloneDriverEnv> =
  createStandaloneDriver({
    driverKind: ProviderDriverKind.make("zed"),
    displayName: "Zed",
    configSchema: ZedSettings,
    probe: probeZed,
  });

export const CloudflareDriver: ProviderDriver<CloudflareSettings, StandaloneDriverEnv> =
  createStandaloneDriver({
    driverKind: ProviderDriverKind.make("cloudflare"),
    displayName: "Cloudflare",
    configSchema: CloudflareSettings,
    probe: (config, env): Effect.Effect<StandaloneProbeResult> =>
      Effect.sync(() => {
        const token = config.apiToken || env.CLOUDFLARE_API_TOKEN;
        const accountId = config.accountId || env.CLOUDFLARE_ACCOUNT_ID;
        const hasToken = Boolean(token && token.trim().length > 0);
        const hasAccountId = Boolean(accountId && accountId.trim().length > 0);
        const builtInModels: ReadonlyArray<ServerProviderModel> = [
          {
            slug: "@cf/meta/llama-3.3-70b-instruct",
            name: "Llama 3.3 70B Instruct",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
            name: "DeepSeek R1 Distill Qwen 32B",
            isDefault: false,
            isCustom: false,
            capabilities: null,
          },
        ];
        const models = providerModelsFromSettings(builtInModels, config.customModels, null);

        if (hasToken && hasAccountId) {
          return {
            installed: true,
            status: "ready",
            auth: { status: "authenticated", label: "Cloudflare Workers AI" },
            models,
          };
        }

        if (hasToken && !hasAccountId) {
          return {
            installed: true,
            status: "warning",
            auth: { status: "unauthenticated", label: "Cloudflare Account ID" },
            message: "Enter a Cloudflare Account ID in provider settings.",
            models,
          };
        }

        return {
          installed: true,
          status: "warning",
          auth: { status: "unauthenticated", label: "Cloudflare API Token" },
          message: "Enter a Cloudflare API token and Account ID in provider settings.",
          models,
        };
      }),
  });

export const BedrockDriver: ProviderDriver<AwsBedrockSettings, StandaloneDriverEnv> =
  createStandaloneDriver({
    driverKind: ProviderDriverKind.make("bedrock"),
    displayName: "AWS Bedrock",
    configSchema: AwsBedrockSettings,
    probe: (config, env): Effect.Effect<StandaloneProbeResult> =>
      Effect.sync(() => {
        const accessKey = config.accessKeyId || env.AWS_ACCESS_KEY_ID;
        const secretKey = config.secretAccessKey || env.AWS_SECRET_ACCESS_KEY;
        const hasAccessKey = Boolean(accessKey && accessKey.trim().length > 0);
        const hasSecretKey = Boolean(secretKey && secretKey.trim().length > 0);
        const builtInModels: ReadonlyArray<ServerProviderModel> = [
          {
            slug: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            name: "Claude 3.7 Sonnet",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "amazon.nova-pro-v1:0",
            name: "Amazon Nova Pro",
            isDefault: false,
            isCustom: false,
            capabilities: null,
          },
        ];
        const models = providerModelsFromSettings(builtInModels, config.customModels, null);

        if (hasAccessKey && hasSecretKey) {
          return {
            installed: true,
            status: "ready",
            auth: { status: "authenticated", label: "AWS Bedrock" },
            models,
          };
        }

        if (hasAccessKey && !hasSecretKey) {
          return {
            installed: true,
            status: "warning",
            auth: { status: "unauthenticated", label: "AWS Secret Access Key" },
            message: "Enter an AWS Secret Access Key in provider settings.",
            models,
          };
        }

        return {
          installed: true,
          status: "warning",
          auth: { status: "unauthenticated", label: "AWS Credentials" },
          message: "Enter AWS credentials in provider settings.",
          models,
        };
      }),
  });
