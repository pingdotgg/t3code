import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

const services = GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer));

const makeInstance = Effect.all({
  sourceControl: GitLabSourceControlProvider.make,
  discovery: Effect.succeed(GitLabSourceControlProvider.discovery),
  pullRequests: GitLabPullRequestProvider.make,
});

const isRateLimit = Schema.is(GitLabCli.GitLabCliRateLimitError);

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
  rateLimitRefusal: (error) => (isRateLimit(error) ? {} : undefined),
});
