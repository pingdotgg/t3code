import * as CliKit from "../CliKit/index.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Aws from "../../Alchemist/routes/aws.ts";

import { confirmOrDecline } from "./confirm.ts";
import { envFile, yes } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const awsProfile = Flag.String("aws-profile").pipe(
  Flag.withDescription("AWS CLI/SSO profile to use for bootstrap credentials"),
  Flag.optional,
  Flag.map(Option.getOrElse(() => "default")),
);

const awsRegion = Flag.String("region").pipe(
  Flag.withDescription(
    "AWS region to bootstrap (defaults to AWS_REGION env var)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const runBootstrap = Effect.fn(function* (args: {
  envFile: Option.Option<string>;
  profile: string;
  region: string | undefined;
  destroy: boolean;
}) {
  const { envFile, profile, region, destroy } = args;
  const prompt = yield* CliKit.CliKit;
  const target = {
    profile,
    region,
    envFile: Option.getOrUndefined(envFile),
  };
  if (destroy) {
    const result = yield* Aws.teardown(target);
    yield* result.destroyed.length === 0
      ? prompt.output.success("No bootstrap buckets found to destroy")
      : prompt.output.success(
          `Destroyed ${result.destroyed.length} bootstrap bucket(s): ${result.destroyed.join(", ")}`,
        );
    return;
  }
  const result = yield* Aws.bootstrap(target);
  yield* result.created
    ? prompt.output.success(`Created assets bucket: ${result.bucketName}`)
    : prompt.output.success(
        `Assets bucket already exists: ${result.bucketName}`,
      );
});

const teardownCommand = Command.make(
  "teardown",
  { envFile, profile: awsProfile, region: awsRegion, yes },
  instrumentCommand(
    "provider.aws.teardown",
    (a: { profile: string; region: string | undefined }) => ({
      "aws.profile": a.profile,
      "alchemy.region": a.region ?? "",
    }),
  )(
    Effect.fn(function* ({ yes: approved, ...args }) {
      yield* confirmOrDecline({
        yes: approved,
        message: "Destroy every Alchemy bootstrap bucket in this AWS region?",
        confirmLabel: "Destroy",
        cancelLabel: "Cancel",
      });
      yield* runBootstrap({ ...args, destroy: true });
    }),
  ),
).pipe(Command.withDescription("Destroy the AWS deployment assets buckets"));

const bootstrapCommand = Command.make(
  "bootstrap",
  { envFile, profile: awsProfile, region: awsRegion },
  instrumentCommand(
    "provider.aws.bootstrap",
    (a: { profile: string; region: string | undefined }) => ({
      "aws.profile": a.profile,
      "alchemy.region": a.region ?? "",
    }),
  )(
    Effect.fn(function* (args) {
      yield* runBootstrap({ ...args, destroy: false });
    }),
  ),
).pipe(Command.withDescription("Provision the AWS deployment assets bucket"));

export const awsCommand = Command.make("aws", {}).pipe(
  Command.withDescription("Manage AWS provider prerequisites"),
  Command.withSubcommands([bootstrapCommand, teardownCommand]),
);
