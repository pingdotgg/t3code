import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabCredentials from "./GitLabCredentials.ts";
import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

const services = Layer.merge(
  GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer)),
  GitLabCredentials.layer,
);

const makeInstance = Effect.all({
  sourceControl: GitLabSourceControlProvider.make,
  discovery: Effect.succeed(GitLabSourceControlProvider.discovery),
  pullRequests: GitLabPullRequestProvider.make,
  fetchMedia: GitLabMediaFetch.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
