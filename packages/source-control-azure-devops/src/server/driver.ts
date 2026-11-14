import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const services = AzureDevOpsPullRequestCli.layer.pipe(Layer.provideMerge(AzureDevOpsCli.layer));

const makeInstance = Effect.all({
  sourceControl: AzureDevOpsSourceControlProvider.make,
  discovery: Effect.succeed(AzureDevOpsSourceControlProvider.discovery),
  pullRequests: AzureDevOpsPullRequestProvider.make,
});

const isRateLimit = Schema.is(AzureDevOpsCli.AzureDevOpsCliRateLimitError);

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
  rateLimitRefusal: (error) => (isRateLimit(error) ? {} : undefined),
});
