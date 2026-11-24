import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

export const hostedAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapEffect(validateHostedAppUrl));

const NIGHTLY_HOSTED_APP_URL = "https://nightly.app.t3.codes";

/**
 * Where agent sign-ins on the T3 Connect address are approved. A nightly build defaults to the
 * nightly hosted app, which ships the same approval page; app.t3.codes serves stable.
 */
export const agentApprovalAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  typeof __T3CODE_BUILD_CHANNEL__ !== "undefined" && __T3CODE_BUILD_CHANNEL__ === "nightly"
    ? NIGHTLY_HOSTED_APP_URL
    : DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapEffect(validateHostedAppUrl));

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    clerkPublishableKey: makePublicValueConfig(
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKeyFallback,
    ),
    clientId: makePublicValueConfig(
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      clerkCliOAuthClientIdFallback,
    ),
  }).pipe(
    Config.mapEffect(({ clerkPublishableKey, clientId }) =>
      Effect.try({
        try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              deviceAuthorizationEndpoint: `${clerkFrontendApiUrl}/oauth/device_authorization`,
              clientId,
              loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
              redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthConfig,
        ),
      ),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (normalizeSecureRelayUrl(process.env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
  (process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
  (process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId),
);
