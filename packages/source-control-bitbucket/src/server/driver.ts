import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../client/definition.ts";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

// Every setting the API reads from the environment is optional, so reading them cannot fail.
const services = BitbucketPullRequestApi.layer.pipe(
  Layer.provideMerge(BitbucketApi.layer),
  Layer.orDie,
);

/** Over this host's own services, which `driver` builds; tests stand in for them. */
export const makeInstance = Effect.all({
  sourceControl: BitbucketSourceControlProvider.make,
  discovery: BitbucketSourceControlProvider.makeDiscovery,
  pullRequests: BitbucketPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
