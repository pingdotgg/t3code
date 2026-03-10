import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

function optionalString(name: string) {
  return Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined));
}

export const envConfig = Config.all({
  BETTER_AUTH_SECRET: optionalString("BETTER_AUTH_SECRET"),
  BETTER_AUTH_TRUSTED_ORIGINS: optionalString("BETTER_AUTH_TRUSTED_ORIGINS"),
  BETTER_AUTH_URL: optionalString("BETTER_AUTH_URL"),
  CONVEX_URL: optionalString("CONVEX_URL"),
  CONVEX_SITE_URL: optionalString("CONVEX_SITE_URL"),
  NEXT_PUBLIC_CONVEX_URL: optionalString("NEXT_PUBLIC_CONVEX_URL"),
  NEXT_PUBLIC_CONVEX_SITE_URL: optionalString("NEXT_PUBLIC_CONVEX_SITE_URL"),
  DAYTONA_API_KEY: optionalString("DAYTONA_API_KEY"),
  DAYTONA_API_URL: optionalString("DAYTONA_API_URL"),
  DAYTONA_AUTO_STOP_INTERVAL: Config.int("DAYTONA_AUTO_STOP_INTERVAL").pipe(Config.withDefault(15)),
  DAYTONA_JEVIN_IMAGE: optionalString("DAYTONA_JEVIN_IMAGE"),
  DAYTONA_JEVIN_SNAPSHOT: optionalString("DAYTONA_JEVIN_SNAPSHOT"),
  DAYTONA_ORG_VOLUME_MOUNT_PATH: Config.string("DAYTONA_ORG_VOLUME_MOUNT_PATH").pipe(
    Config.withDefault("/workspace"),
  ),
  DAYTONA_SANDBOX_ID: optionalString("DAYTONA_SANDBOX_ID"),
  DAYTONA_TARGET: optionalString("DAYTONA_TARGET"),
  GITHUB_CLIENT_ID: optionalString("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: optionalString("GITHUB_CLIENT_SECRET"),
  GITHUB_APP_ID: optionalString("GITHUB_APP_ID"),
  GITHUB_APP_PRIVATE_KEY: optionalString("GITHUB_APP_PRIVATE_KEY"),
  GITHUB_APP_SLUG: optionalString("GITHUB_APP_SLUG"),
  GITHUB_APP_WEBHOOK_SECRET: optionalString("GITHUB_APP_WEBHOOK_SECRET"),
  GITHUB_TOKEN: optionalString("GITHUB_TOKEN"),
  SERVER_WS_URL: optionalString("SERVER_WS_URL"),
  SERVER_BETA_HISTORY_BASE_URL: optionalString("SERVER_BETA_HISTORY_BASE_URL"),
  SERVER_BETA_HISTORY_TOKEN: optionalString("SERVER_BETA_HISTORY_TOKEN"),
  SERVER_BETA_NAMESPACE: optionalString("SERVER_BETA_NAMESPACE"),
});

export interface SharedEnv {
  readonly BETTER_AUTH_SECRET: string | undefined;
  readonly BETTER_AUTH_TRUSTED_ORIGINS: string | undefined;
  readonly BETTER_AUTH_URL: string | undefined;
  readonly CONVEX_URL: string | undefined;
  readonly CONVEX_SITE_URL: string | undefined;
  readonly NEXT_PUBLIC_CONVEX_URL: string | undefined;
  readonly NEXT_PUBLIC_CONVEX_SITE_URL: string | undefined;
  readonly DAYTONA_API_KEY: string | undefined;
  readonly DAYTONA_API_URL: string | undefined;
  readonly DAYTONA_AUTO_STOP_INTERVAL: number;
  readonly DAYTONA_JEVIN_IMAGE: string | undefined;
  readonly DAYTONA_JEVIN_SNAPSHOT: string | undefined;
  readonly DAYTONA_ORG_VOLUME_MOUNT_PATH: string;
  readonly DAYTONA_SANDBOX_ID: string | undefined;
  readonly DAYTONA_TARGET: string | undefined;
  readonly GITHUB_CLIENT_ID: string | undefined;
  readonly GITHUB_CLIENT_SECRET: string | undefined;
  readonly GITHUB_APP_ID: string | undefined;
  readonly GITHUB_APP_PRIVATE_KEY: string | undefined;
  readonly GITHUB_APP_SLUG: string | undefined;
  readonly GITHUB_APP_WEBHOOK_SECRET: string | undefined;
  readonly GITHUB_TOKEN: string | undefined;
  readonly SERVER_WS_URL: string | undefined;
  readonly SERVER_BETA_HISTORY_BASE_URL: string | undefined;
  readonly SERVER_BETA_HISTORY_TOKEN: string | undefined;
  readonly SERVER_BETA_NAMESPACE: string | undefined;
}

export function loadEnv(): Effect.Effect<SharedEnv, Config.ConfigError> {
  return envConfig.asEffect().pipe(Effect.map((loadedEnv) => loadedEnv satisfies SharedEnv));
}

function readOptionalStringFromProcessEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readIntFromProcessEnv(name: string, fallback: number): number {
  const value = readOptionalStringFromProcessEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readEnvSnapshot(): SharedEnv {
  return {
    BETTER_AUTH_SECRET: readOptionalStringFromProcessEnv("BETTER_AUTH_SECRET"),
    BETTER_AUTH_TRUSTED_ORIGINS: readOptionalStringFromProcessEnv("BETTER_AUTH_TRUSTED_ORIGINS"),
    BETTER_AUTH_URL: readOptionalStringFromProcessEnv("BETTER_AUTH_URL"),
    CONVEX_URL: readOptionalStringFromProcessEnv("CONVEX_URL"),
    CONVEX_SITE_URL: readOptionalStringFromProcessEnv("CONVEX_SITE_URL"),
    NEXT_PUBLIC_CONVEX_URL: readOptionalStringFromProcessEnv("NEXT_PUBLIC_CONVEX_URL"),
    NEXT_PUBLIC_CONVEX_SITE_URL: readOptionalStringFromProcessEnv("NEXT_PUBLIC_CONVEX_SITE_URL"),
    DAYTONA_API_KEY: readOptionalStringFromProcessEnv("DAYTONA_API_KEY"),
    DAYTONA_API_URL: readOptionalStringFromProcessEnv("DAYTONA_API_URL"),
    DAYTONA_AUTO_STOP_INTERVAL: readIntFromProcessEnv("DAYTONA_AUTO_STOP_INTERVAL", 15),
    DAYTONA_JEVIN_IMAGE: readOptionalStringFromProcessEnv("DAYTONA_JEVIN_IMAGE"),
    DAYTONA_JEVIN_SNAPSHOT: readOptionalStringFromProcessEnv("DAYTONA_JEVIN_SNAPSHOT"),
    DAYTONA_ORG_VOLUME_MOUNT_PATH:
      readOptionalStringFromProcessEnv("DAYTONA_ORG_VOLUME_MOUNT_PATH") ?? "/workspace",
    DAYTONA_SANDBOX_ID: readOptionalStringFromProcessEnv("DAYTONA_SANDBOX_ID"),
    DAYTONA_TARGET: readOptionalStringFromProcessEnv("DAYTONA_TARGET"),
    GITHUB_CLIENT_ID: readOptionalStringFromProcessEnv("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: readOptionalStringFromProcessEnv("GITHUB_CLIENT_SECRET"),
    GITHUB_APP_ID: readOptionalStringFromProcessEnv("GITHUB_APP_ID"),
    GITHUB_APP_PRIVATE_KEY: readOptionalStringFromProcessEnv("GITHUB_APP_PRIVATE_KEY"),
    GITHUB_APP_SLUG: readOptionalStringFromProcessEnv("GITHUB_APP_SLUG"),
    GITHUB_APP_WEBHOOK_SECRET: readOptionalStringFromProcessEnv("GITHUB_APP_WEBHOOK_SECRET"),
    GITHUB_TOKEN: readOptionalStringFromProcessEnv("GITHUB_TOKEN"),
    SERVER_WS_URL: readOptionalStringFromProcessEnv("SERVER_WS_URL"),
    SERVER_BETA_HISTORY_BASE_URL: readOptionalStringFromProcessEnv("SERVER_BETA_HISTORY_BASE_URL"),
    SERVER_BETA_HISTORY_TOKEN: readOptionalStringFromProcessEnv("SERVER_BETA_HISTORY_TOKEN"),
    SERVER_BETA_NAMESPACE: readOptionalStringFromProcessEnv("SERVER_BETA_NAMESPACE"),
  } satisfies SharedEnv;
}

export function resolveConvexUrl(
  env: Pick<SharedEnv, "CONVEX_URL" | "NEXT_PUBLIC_CONVEX_URL">,
): string | undefined {
  return env.CONVEX_URL ?? env.NEXT_PUBLIC_CONVEX_URL;
}

export function resolveConvexSiteUrl(
  env: Pick<SharedEnv, "CONVEX_SITE_URL" | "NEXT_PUBLIC_CONVEX_SITE_URL">,
): string | undefined {
  return env.CONVEX_SITE_URL ?? env.NEXT_PUBLIC_CONVEX_SITE_URL;
}
