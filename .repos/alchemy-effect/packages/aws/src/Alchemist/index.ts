import * as Auth from "@distilled.cloud/aws/Auth";
import type * as Alchemist from "alchemy/Alchemist";
import { loadConfigProvider } from "alchemy/Util/ConfigProvider";
import * as ConfigProvider from "effect/ConfigProvider";
import * as EffectConsole from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../AssetsBucket.ts";
import { getAccountId, silentConsole } from "../AuthProvider.ts";
import * as AWSCredentials from "../Credentials.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as AWSRegion from "../Region.ts";

export interface AwsTarget extends Alchemist.Target {
  readonly profile: string;
  readonly region?: string;
}

const environment = Effect.fn(function* (target: AwsTarget) {
  // SSO (`sso_account_id`) or console-login (`login_session`) profiles;
  // distilled resolves both.
  const profile = yield* Auth.loadProfile(target.profile);
  const region = target.region ?? profile.region ?? "us-east-1";
  // The credentials effect runs later, inside the built layer, where these
  // services are no longer in context — capture them here so the route's
  // requirements stay visible in its type.
  const credentialServices =
    yield* Effect.context<Effect.Services<ReturnType<typeof Auth.loadProfileCredentials>>>();
  const credentials = Auth.loadProfileCredentials(target.profile).pipe(
    Effect.provideService(EffectConsole.Console, silentConsole),
    Effect.provide(credentialServices),
  );
  // A console-login profile records no account id; ask STS.
  const accountId = profile.sso_account_id ?? (yield* Effect.flatMap(credentials, getAccountId));
  const aws = Layer.provideMerge(
    Layer.mergeAll(AWSRegion.fromEnvironment, AWSCredentials.fromEnvironment),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId,
        region,
        credentials,
        profile: target.profile,
      }),
    ),
  );
  return {
    accountId,
    region,
    layer: Layer.provide(
      aws,
      ConfigProvider.layer(yield* loadConfigProvider(Option.fromNullishOr(target.envFile))),
    ),
  };
});

/** Provision the AWS deployment assets bucket. */
export const bootstrap = Effect.fn("Alchemist.provider.aws.bootstrap")(function* (
  target: AwsTarget,
) {
  const env = yield* environment(target);
  const result = yield* Effect.provide(bootstrapAws(), env.layer);
  return { accountId: env.accountId, region: env.region, ...result };
});

/** Destroy every Alchemy bootstrap bucket in the region. */
export const teardown = Effect.fn("Alchemist.provider.aws.teardown")(function* (target: AwsTarget) {
  const env = yield* environment(target);
  const result = yield* Effect.provide(destroyBootstrapAws(), env.layer);
  return {
    accountId: env.accountId,
    region: env.region,
    destroyed: result.bucketNames,
  };
});
