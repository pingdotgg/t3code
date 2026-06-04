import * as Auth from "@distilled.cloud/aws/Auth";
import {
  fromAwsCredentialIdentity,
  type CredentialsError,
  type ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import type { AwsCredentialIdentity } from "@smithy/types";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

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
  AWSEnvironmentShape
>()("AWS::Environment") {}

/**
 * Build an `AWSEnvironment` from one of two sources, in priority order:
 *
 *   1. **Environment variables** — used when `AWS_ACCESS_KEY_ID` is set, as
 *      it is on GitHub Actions runners after `aws-actions/configure-aws-credentials`
 *      runs (OIDC), or whenever the user has exported static creds. Requires
 *      `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_ACCOUNT_ID`. The role
 *      ARN's account ID is exported by `configure-aws-credentials` as
 *      `AWS_ACCOUNT_ID` when invoked with `output-credentials: true`.
 *   2. **SSO profile** (`AWS_PROFILE`, default `"default"`) — used locally
 *      when no static creds are exported. Reads the profile's
 *      `sso_account_id` / `region` from `~/.aws/config` and refreshes
 *      credentials lazily via `aws sso login`.
 */
export const Default = Layer.effect(
  AWSEnvironment,
  Effect.suspend(() => loadDefault()),
).pipe(Layer.orDie);

export const loadDefault = () =>
  Effect.gen(function* () {
    // Env-credentials path only kicks in under CI (where
    // `aws-actions/configure-aws-credentials` exports AWS_ACCESS_KEY_ID
    // and friends). Locally we always go through SSO so a stray
    // AWS_ACCESS_KEY_ID in the shell doesn't silently override the
    // user's `~/.aws/config` profile.
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    if (ci) {
      const accessKeyId = yield* AWS_ACCESS_KEY_ID.pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      if (accessKeyId) {
        return yield* loadFromEnv(accessKeyId);
      }
    }
    return yield* loadFromSso();
  });

const loadFromEnv = (accessKeyId: string) =>
  Effect.gen(function* () {
    const secretAccessKey = yield* AWS_SECRET_ACCESS_KEY;
    const sessionToken = yield* AWS_SESSION_TOKEN.pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const region = yield* AWS_REGION;
    const accountId = yield* AWS_ACCOUNT_ID;
    return {
      accountId,
      region,
      credentials: Effect.succeed({
        accessKeyId: Redacted.make(accessKeyId),
        secretAccessKey,
        sessionToken,
      } satisfies ResolvedCredentials),
    } satisfies AWSEnvironmentShape;
  });

const loadFromSso = () =>
  Effect.gen(function* () {
    const profileName = yield* AWS_PROFILE;
    const auth = yield* Auth.Default;
    const profile = yield* auth.loadProfile(profileName);
    if (!profile.sso_account_id) {
      return yield* Effect.die(
        `AWS SSO profile '${profileName}' is missing sso_account_id`,
      );
    }
    const region =
      profile.region ??
      (yield* AWS_REGION.pipe(
        Config.option,
        Config.map(Option.getOrElse(() => "us-east-1")),
      ));
    return {
      profile: profileName,
      accountId: profile.sso_account_id,
      region,
      credentials: auth.loadProfileCredentials(profileName),
    } satisfies AWSEnvironmentShape;
  });

export interface AWSEnvironmentStaticInput {
  accountId: AccountID;
  region: RegionID;
  credentials: AwsCredentialIdentity;
  endpoint?: string;
  profile?: string;
}

const isStatic = (
  shape: AWSEnvironmentShape | AWSEnvironmentStaticInput,
): shape is AWSEnvironmentStaticInput =>
  shape.credentials != null &&
  typeof (shape.credentials as AwsCredentialIdentity).accessKeyId === "string";

/**
 * Build an `AWSEnvironment` Layer directly from values — useful for
 * static credentials in CI or tests.
 *
 * Named `makeEnvironment` rather than `of` because `Context.Service.of`
 * already exists with different semantics (builds the service value, not
 * a Layer); putting both on `AWSEnvironment` would be confusing.
 */
export const makeEnvironment = (
  shape: AWSEnvironmentShape | AWSEnvironmentStaticInput,
) =>
  Layer.succeed(
    AWSEnvironment,
    isStatic(shape)
      ? {
          ...shape,
          credentials: Effect.succeed(
            fromAwsCredentialIdentity(shape.credentials),
          ),
        }
      : shape,
  );
