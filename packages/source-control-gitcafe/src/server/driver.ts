/**
 * The GitCafe driver: repository operations and discovery through `cafe` and git, and pull
 * requests through GitCafe's REST API on git.cafe and staging.git.cafe.
 *
 * @module source-control-gitcafe/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";
import * as GitCafeSourceControlProvider from "./GitCafeSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: "gitcafe",
  make: Effect.all({
    sourceControl: GitCafeSourceControlProvider.make,
    discovery: Effect.succeed(GitCafeSourceControlProvider.discovery),
    pullRequests: GitCafePullRequestProvider.make,
  }),
});
