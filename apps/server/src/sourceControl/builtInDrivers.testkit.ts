import * as AzureDevOpsDriver from "@t3tools/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@t3tools/source-control-bitbucket/server/driver";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@t3tools/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BuiltInDrivers from "./builtInDrivers.ts";

const entry = (
  driver: SourceControlDriver,
  instance: SourceControlDriverInstance,
): BuiltInDrivers.SourceControlDriverEntry => ({ driver, instance });

/** Every built-in driver over whatever stands in for its host's own services. */
export const layerOverHostServices = Layer.effect(
  BuiltInDrivers.SourceControlDrivers,
  Effect.all([
    GitHubDriver.makeInstance.pipe(Effect.map((instance) => entry(GitHubDriver.driver, instance))),
    GitLabDriver.makeInstance.pipe(Effect.map((instance) => entry(GitLabDriver.driver, instance))),
    GitCafeDriver.makeInstance.pipe(
      Effect.map((instance) => entry(GitCafeDriver.driver, instance)),
    ),
    ForgejoDriver.makeInstance.pipe(
      Effect.map((instance) => entry(ForgejoDriver.driver, instance)),
    ),
    BitbucketDriver.makeInstance.pipe(
      Effect.map((instance) => entry(BitbucketDriver.driver, instance)),
    ),
    AzureDevOpsDriver.makeInstance.pipe(
      Effect.map((instance) => entry(AzureDevOpsDriver.driver, instance)),
    ),
  ]),
);
