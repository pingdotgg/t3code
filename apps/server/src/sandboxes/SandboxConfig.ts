import {
  layerSandboxProviderRegistry,
  makeCodeSandboxDriver,
  makeUpstashBoxDriver,
  makeVercelSandboxDriver,
  type SandboxProviderRegistration,
  type SandboxProviderRegistry,
} from "@t3tools/sandbox-providers";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const DEFAULT_SANDBOX_IDLE_TIMEOUT_MINUTES = 8;
export const SANDBOX_SERVER_PORT = 3773;

export interface SandboxRuntimeConfig {
  readonly defaultIdleTimeoutMinutes: number;
  readonly codesandboxApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly upstashBoxApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly vercelOidcToken: Option.Option<Redacted.Redacted<string>>;
  readonly vercelToken: Option.Option<Redacted.Redacted<string>>;
  readonly vercelTeamId: Option.Option<string>;
  readonly vercelProjectId: Option.Option<string>;
  readonly defaultSnapshots: {
    readonly codesandbox: string | null;
    readonly upstashBox: string | null;
    readonly vercelSandbox: string | null;
  };
  readonly passthroughSecrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly cliPackageSpec?: string | undefined;
  readonly forwardHostOAuth?: boolean | undefined;
}

export class SandboxConfig extends Context.Service<SandboxConfig, SandboxRuntimeConfig>()(
  "t3/sandboxes/SandboxConfig",
) {}

const optionalTrimmedString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) =>
      Option.flatMap(value, (raw) => {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const optionalRedacted = (name: string) =>
  optionalTrimmedString(name).pipe(Config.map(Option.map(Redacted.make)));

const readSandboxConfig = Effect.fn("SandboxConfig.read")(function* () {
  const rawIdleMinutes = yield* Config.Int("SANDBOX_IDLE_TIMEOUT_MINUTES").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const defaultIdleTimeoutMinutes = Math.min(
    1440,
    Math.max(
      1,
      Option.getOrElse(rawIdleMinutes, () => DEFAULT_SANDBOX_IDLE_TIMEOUT_MINUTES),
    ),
  );

  const primaryCsbKey = yield* optionalRedacted("CODESANDBOX_API_KEY").pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
  );
  const fallbackCsbKey = yield* optionalRedacted("CSB_API_KEY").pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
  );
  const codesandboxApiKey = Option.orElse(primaryCsbKey, () => fallbackCsbKey);

  const upstashBoxApiKey = yield* optionalRedacted("UPSTASH_BOX_API_KEY").pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
  );
  const vercelOidcToken = yield* optionalRedacted("VERCEL_OIDC_TOKEN").pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
  );
  const vercelToken = yield* optionalRedacted("VERCEL_TOKEN").pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
  );
  const vercelTeamId = yield* optionalTrimmedString("VERCEL_TEAM_ID").pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const vercelProjectId = yield* optionalTrimmedString("VERCEL_PROJECT_ID").pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const defaultSnapshotCsb = yield* optionalTrimmedString(
    "SANDBOX_DEFAULT_SNAPSHOT_CODESANDBOX",
  ).pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const defaultSnapshotUpstash = yield* optionalTrimmedString(
    "SANDBOX_DEFAULT_SNAPSHOT_UPSTASH",
  ).pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const defaultSnapshotVercel = yield* optionalTrimmedString(
    "SANDBOX_DEFAULT_SNAPSHOT_VERCEL",
  ).pipe(Effect.orElseSucceed(() => Option.none<string>()));

  const secretEnvNames = [
    "PRIME_API_KEY",
    "RLM_MAX_DEPTH",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GITHUB_TOKEN",
    "T3_CONNECT_BOOTSTRAP_TOKEN",
    "TAILSCALE_AUTHKEY",
    "RELAY_PUBLIC_URL",
    "T3CODE_RELAY_URL",
    "HOSTED_APP_URL",
    "T3CODE_HOSTED_APP_URL",
    "CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "CLERK_JWT_TEMPLATE",
    "T3CODE_CLERK_JWT_TEMPLATE",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  ] as const;

  const cliPackageSpec = yield* optionalTrimmedString("SANDBOX_CLI_PACKAGE").pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const forwardHostOAuth = yield* Config.Boolean("SANDBOX_FORWARD_HOST_OAUTH").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );

  const passthroughSecrets: Record<string, Redacted.Redacted<string>> = {};
  for (const envName of secretEnvNames) {
    const secret = yield* optionalRedacted(envName).pipe(
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
    );
    if (Option.isSome(secret)) {
      passthroughSecrets[envName] = secret.value;
    }
  }

  return SandboxConfig.of({
    defaultIdleTimeoutMinutes,
    codesandboxApiKey,
    upstashBoxApiKey,
    vercelOidcToken,
    vercelToken,
    vercelTeamId,
    vercelProjectId,
    defaultSnapshots: {
      codesandbox: Option.getOrNull(defaultSnapshotCsb),
      upstashBox: Option.getOrNull(defaultSnapshotUpstash),
      vercelSandbox: Option.getOrNull(defaultSnapshotVercel),
    },
    passthroughSecrets,
    cliPackageSpec: Option.getOrUndefined(cliPackageSpec),
    forwardHostOAuth,
  });
});

export const layer = Layer.effect(SandboxConfig, readSandboxConfig());

function buildProviderRegistrations(
  config: SandboxRuntimeConfig,
): ReadonlyArray<SandboxProviderRegistration> {
  const hasVercelAccessToken =
    Option.isSome(config.vercelToken) &&
    Option.isSome(config.vercelTeamId) &&
    Option.isSome(config.vercelProjectId);
  const hasVercelOidc = Option.isSome(config.vercelOidcToken);

  return [
    {
      provider: "codesandbox",
      driver: Option.isSome(config.codesandboxApiKey)
        ? makeCodeSandboxDriver({ apiKey: config.codesandboxApiKey.value })
        : null,
      defaultSnapshotId: config.defaultSnapshots.codesandbox,
      unconfiguredReason: "Set CODESANDBOX_API_KEY (or CSB_API_KEY) to enable CodeSandbox.",
    },
    {
      provider: "upstash-box",
      driver: Option.isSome(config.upstashBoxApiKey)
        ? makeUpstashBoxDriver({ apiKey: config.upstashBoxApiKey.value })
        : null,
      defaultSnapshotId: config.defaultSnapshots.upstashBox,
      unconfiguredReason: "Set UPSTASH_BOX_API_KEY to enable Upstash Box.",
    },
    {
      provider: "vercel-sandbox",
      driver:
        hasVercelAccessToken || hasVercelOidc
          ? makeVercelSandboxDriver(
              hasVercelAccessToken
                ? {
                    token: config.vercelToken.value,
                    teamId: config.vercelTeamId.value,
                    projectId: config.vercelProjectId.value,
                  }
                : {},
            )
          : null,
      defaultSnapshotId: config.defaultSnapshots.vercelSandbox,
      unconfiguredReason:
        "Set VERCEL_OIDC_TOKEN or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID to enable Vercel Sandbox.",
    },
  ];
}

export const layerProviderRegistry: Layer.Layer<SandboxProviderRegistry, never, SandboxConfig> =
  Layer.unwrap(
    Effect.map(SandboxConfig, (config) =>
      layerSandboxProviderRegistry(buildProviderRegistrations(config)),
    ),
  );
