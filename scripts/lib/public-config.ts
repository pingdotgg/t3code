// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface T3CodePublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(baseEnv, localEnv, rootEnv);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          HYAKKI_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          HYAKKI_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          HYAKKI_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.relayUrl
      ? {
          HYAKKI_RELAY_URL: config.relayUrl,
          VITE_HYAKKI_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          HYAKKI_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          HYAKKI_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          HYAKKI_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          HYAKKI_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          HYAKKI_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          HYAKKI_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "HYAKKI_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "HYAKKI_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "HYAKKI_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "HYAKKI_RELAY_URL", "VITE_HYAKKI_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "HYAKKI_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "HYAKKI_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "HYAKKI_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "HYAKKI_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "HYAKKI_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "HYAKKI_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
