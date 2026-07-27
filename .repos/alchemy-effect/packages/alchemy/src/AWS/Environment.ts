import type {
  CredentialsError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  AWS_AUTH_PROVIDER_NAME,
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
  readonly kind = "Environment" as const;
}

export const Default = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const profile = yield* AlchemyProfile;
    const auth = yield* getAuthProvider<AwsAuthConfig, AwsResolvedCredentials>(
      AWS_AUTH_PROVIDER_NAME,
    );
    const profileName = yield* ALCHEMY_PROFILE;
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

    return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
      Effect.flatMap((config) => auth.read(profileName, config)),
      Effect.orDie,
      Effect.cached,
    );
  }),
).pipe(Layer.orDie);
