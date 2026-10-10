/**
 * The Bitbucket Cloud driver: repository operations, discovery, and pull requests through the
 * Bitbucket REST API.
 *
 * @module source-control-bitbucket/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: "bitbucket",
  make: Effect.all({
    sourceControl: BitbucketSourceControlProvider.make,
    discovery: BitbucketSourceControlProvider.makeDiscovery,
    pullRequests: BitbucketPullRequestProvider.make,
  }),
});
