import * as Auth from "@distilled.cloud/aws/Auth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import type { HttpClient } from "effect/unstable/http/HttpClient";

import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../../AWS/Bootstrap.ts";
import * as AWSCredentials from "../../AWS/Credentials.ts";
import * as AWSEnvironment from "../../AWS/Environment.ts";
import * as AWSRegion from "../../AWS/Region.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { envFile, instrumentCommand } from "./_shared.ts";

const awsProfile = Flag.string("profile").pipe(
  Flag.withDescription("AWS profile to use for credentials"),
  Flag.optional,
  Flag.map(Option.getOrElse(() => "default")),
);

const awsRegion = Flag.string("region").pipe(
  Flag.withDescription(
    "AWS region to bootstrap (defaults to AWS_REGION env var)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapDestroy = Flag.boolean("destroy").pipe(
  Flag.withDescription("Destroy all bootstrap buckets in the selected region"),
  Flag.withDefault(false),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile: awsProfile,
    region: awsRegion,
    destroy: bootstrapDestroy,
  },
  instrumentCommand(
    "aws.bootstrap",
    (a: { profile: string; region: string | undefined; destroy: boolean }) => ({
      "alchemy.profile": a.profile,
      "alchemy.region": a.region ?? "",
      "alchemy.destroy": a.destroy,
    }),
  )(
    Effect.fnUntraced(function* ({ envFile, profile, region, destroy }) {
      const logger = Logger.layer([fileLogger("bootstrap.txt")], {
        mergeWithExisting: true,
      });

      return yield* Effect.gen(function* () {
        const ssoProfile = yield* Auth.loadProfile(profile);
        if (!ssoProfile.sso_account_id) {
          return yield* Effect.die(
            `AWS SSO profile '${profile}' is missing sso_account_id`,
          );
        }

        const ambient = yield* Effect.context<FileSystem | Path | HttpClient>();
        const environment = AWSEnvironment.makeEnvironment({
          accountId: ssoProfile.sso_account_id,
          region: region ?? ssoProfile.region ?? "us-east-1",
          credentials: Auth.loadProfileCredentials(profile).pipe(
            Effect.provide(ambient),
          ),
          profile,
        });

        const awsLayers = Layer.provideMerge(
          Layer.mergeAll(
            AWSRegion.fromEnvironment,
            AWSCredentials.fromEnvironment,
          ),
          environment,
        );

        return yield* Effect.gen(function* () {
          const provider = yield* loadConfigProvider(envFile);
          const bootstrapLayer = Layer.provide(
            awsLayers,
            Layer.succeed(ConfigProvider.ConfigProvider, provider),
          );
          if (destroy) {
            yield* destroyBootstrapAws().pipe(
              Effect.tap((result) =>
                result.destroyed === 0
                  ? Console.log("✓ No bootstrap buckets found to destroy")
                  : Console.log(
                      `✓ Destroyed ${result.destroyed} bootstrap bucket(s): ${result.bucketNames.join(", ")}`,
                    ),
              ),
              Effect.provide(bootstrapLayer),
            );
            return;
          }
          yield* bootstrapAws().pipe(
            Effect.tap(({ bucketName, created }) =>
              created
                ? Console.log(`✓ Created assets bucket: ${bucketName}`)
                : Console.log(`✓ Assets bucket already exists: ${bucketName}`),
            ),
            Effect.provide(bootstrapLayer),
          );
        });
      }).pipe(Effect.provide(logger));
    }),
  ),
);

export const awsCommand = Command.make("aws", {}).pipe(
  Command.withSubcommands([bootstrapCommand]),
);
