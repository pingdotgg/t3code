import * as Auth from "@distilled.cloud/aws/Auth";
import * as EffectConsole from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { silentConsole } from "../../AWS/AuthProvider.ts";
import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../../AWS/Bootstrap.ts";
import * as AWSCredentials from "../../AWS/Credentials.ts";
import { AWSEnvironment } from "../../AWS/Environment.ts";
import * as AWSRegion from "../../AWS/Region.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import type { Target } from "../Session.ts";

export interface AwsTarget extends Target {
  readonly profile: string;
  readonly region?: string;
}

const environment = Effect.fn(function* (target: AwsTarget) {
  const ssoProfile = yield* Auth.loadProfile(target.profile);
  if (!ssoProfile.sso_account_id) {
    return yield* Effect.fail(
      new AuthError({
        message: `AWS SSO profile '${target.profile}' is missing sso_account_id`,
      }),
    );
  }
  const region = target.region ?? ssoProfile.region ?? "us-east-1";
  // The credentials effect runs later, inside the built layer, where these
  // services are no longer in context — capture them here so the route's
  // requirements stay visible in its type.
  const credentialServices =
    yield* Effect.context<
      Effect.Services<ReturnType<typeof Auth.loadProfileCredentials>>
    >();
  const aws = Layer.provideMerge(
    Layer.mergeAll(AWSRegion.fromEnvironment, AWSCredentials.fromEnvironment),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: ssoProfile.sso_account_id,
        region,
        credentials: Auth.loadProfileCredentials(target.profile).pipe(
          Effect.provideService(EffectConsole.Console, silentConsole),
          Effect.provide(credentialServices),
        ),
        profile: target.profile,
      }),
    ),
  );
  return {
    accountId: ssoProfile.sso_account_id,
    region,
    layer: Layer.provide(
      aws,
      ConfigProvider.layer(
        yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
      ),
    ),
  };
});

/** Provision the AWS deployment assets bucket. */
export const bootstrap = Effect.fn("Alchemist.provider.aws.bootstrap")(
  function* (target: AwsTarget) {
    const env = yield* environment(target);
    const result = yield* Effect.provide(bootstrapAws(), env.layer);
    return { accountId: env.accountId, region: env.region, ...result };
  },
);

/** Destroy every Alchemy bootstrap bucket in the region. */
export const teardown = Effect.fn("Alchemist.provider.aws.teardown")(function* (
  target: AwsTarget,
) {
  const env = yield* environment(target);
  const result = yield* Effect.provide(destroyBootstrapAws(), env.layer);
  return {
    accountId: env.accountId,
    region: env.region,
    destroyed: result.bucketNames,
  };
});
