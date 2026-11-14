import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

// Every setting the API reads from the environment is optional, so reading them cannot fail.
const services = BitbucketPullRequestApi.layer.pipe(
  Layer.provideMerge(BitbucketApi.layer),
  Layer.orDie,
);

const makeInstance = Effect.all({
  sourceControl: BitbucketSourceControlProvider.make,
  discovery: BitbucketSourceControlProvider.makeDiscovery,
  pullRequests: BitbucketPullRequestProvider.make,
});

const isResponseError = Schema.is(
  Schema.Union([BitbucketApi.BitbucketResponseError, BitbucketApi.BitbucketResponseBodyReadError]),
);

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
  rateLimitRefusal: (error) =>
    isResponseError(error) && error.status === 429
      ? error.retryAt === undefined
        ? {}
        : { retryAt: error.retryAt }
      : undefined,
});
