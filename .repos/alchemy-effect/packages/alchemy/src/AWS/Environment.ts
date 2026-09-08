import type {
  CredentialsError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AlchemyContext } from "../AlchemyContext.ts";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  AWS_AUTH_PROVIDER_NAME,
  LOCAL_ACCOUNT_ID,
  type AwsAuthConfig,
  type AwsResolvedCredentials,
} from "./AuthProvider.ts";

export const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

export const AWS_REGION = Config.string("AWS_REGION");
export const AWS_ACCOUNT_ID = Config.string("AWS_ACCOUNT_ID");
export const AWS_ACCESS_KEY_ID = Config.string("AWS_ACCESS_KEY_ID");
export const AWS_SECRET_ACCESS_KEY = Config.redacted("AWS_SECRET_ACCESS_KEY");
export const AWS_SESSION_TOKEN = Config.redacted("AWS_SESSION_TOKEN");

export type AccountID = string;
export type RegionID = string;

export class FailedToGetAccount extends Data.TaggedError(
  "AWS::Environment::FailedToGetAccount",
)<{
  message: string;
  cause: Error;
}> {}

/**
 * Fully-resolved AWS environment for a stack. Mirrors `CloudflareEnvironment`:
 * one Context.Service that holds account, region, credentials, endpoint, and
 * (optionally) the SSO profile name.
 *
 * `credentials` is held as an Effect so callers can refresh on each access
 * (SSO sessions expire). The Effect itself is constructed once when this
 * service is built; resolving it lazily preserves @distilled.cloud/aws's
 * existing `Credentials` semantics.
 */
export interface AWSEnvironmentShape {
  accountId: AccountID;
  region: RegionID;
  credentials: Effect.Effect<ResolvedCredentials, CredentialsError>;
  endpoint?: string;
  profile?: string;
}

export class AWSEnvironment extends Context.Service<
  AWSEnvironment,
  Effect.Effect<AWSEnvironmentShape>
>()("AWS::Environment") {
  static current = AWSEnvironment.use((env) => env);
  /**
   * Whether this environment is the floci / `{ method: "local" }` emulator
   * (dummy account {@link LOCAL_ACCOUNT_ID}). A set `endpoint` is not
   * enough: `AWS_ENDPOINT_URL` and explicit endpoint overrides also
   * populate it on real-account credentials.
   */
  static isLocalEmulator = Effect.map(
    AWSEnvironment.current,
    (env) => env.accountId === LOCAL_ACCOUNT_ID,
  );
  readonly kind = "Environment" as const;
}

/** @see {@link AWSEnvironment.isLocalEmulator} */
export const isLocalEmulator = AWSEnvironment.isLocalEmulator;

export const Default = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const profile = yield* AlchemyProfile;
    const auth = yield* getAuthProvider<AwsAuthConfig, AwsResolvedCredentials>(
      AWS_AUTH_PROVIDER_NAME,
    );
    const profileName = yield* ALCHEMY_PROFILE;
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    const dev = Option.match(yield* Effect.serviceOption(AlchemyContext), {
      onNone: () => false,
      onSome: (ctx) => ctx.dev,
    });

    // The pre-existing resolution path: stored profile config (or, when
    // nothing is stored, the interactive configure flow / non-interactive
    // AuthError) → resolved credentials. Deploy-mode behavior is unchanged.
    const resolveConfigured = profile
      .loadOrConfigure(auth, profileName, { ci })
      .pipe(Effect.flatMap((config) => auth.read(profileName, config)));

    // Credential-free dev: an `alchemy dev` run must work with zero AWS
    // credentials. When nothing is configured for the active profile, try
    // ambient env-var credentials first (a developer who exported AWS_*
    // wants the real cloud), then fall back to the local emulator — the
    // same environment `{ method: "local" }` produces (dummy creds,
    // account 000000000000, endpoint localhost:4566, ensureFloci).
    // A profile that IS configured keeps its normal resolution (and its
    // normal failures) even in dev.
    const resolveDev = Effect.gen(function* () {
      const stored = yield* profile.getProfile(profileName);
      if (stored?.[AWS_AUTH_PROVIDER_NAME] != null) {
        return yield* resolveConfigured;
      }
      const fromEnv = yield* Effect.result(
        auth.read(profileName, { method: "env" }),
      );
      if (Result.isSuccess(fromEnv)) {
        return fromEnv.success;
      }
      yield* Effect.logInfo("no AWS credentials — using the local emulator");
      return yield* auth.read(profileName, { method: "local" });
    });

    return yield* (dev ? resolveDev : resolveConfigured).pipe(
      Effect.orDie,
      Effect.cached,
    );
  }),
).pipe(Layer.orDie);
