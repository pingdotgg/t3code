import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import { definition } from "../shared/definition.ts";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";
import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

const services = GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer));

const makeInstance = Effect.gen(function* () {
  const mediaHttpClient = yield* HttpClient.HttpClient;
  return yield* Effect.all({
    sourceControl: GitLabSourceControlProvider.make,
    discovery: Effect.succeed(GitLabSourceControlProvider.discovery),
    pullRequests: GitLabPullRequestProvider.make,
    issues: GitLabIssueTracker.make,
    fetchMedia: GitLabMediaFetch.make.pipe(
      Effect.provideService(HttpClient.HttpClient, mediaHttpClient),
    ),
  });
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
