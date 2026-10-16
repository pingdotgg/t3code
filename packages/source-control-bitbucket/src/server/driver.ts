import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("bitbucket"),
  make: Effect.all({
    sourceControl: BitbucketSourceControlProvider.make,
    discovery: BitbucketSourceControlProvider.makeDiscovery,
    pullRequests: BitbucketPullRequestProvider.make,
  }),
});
