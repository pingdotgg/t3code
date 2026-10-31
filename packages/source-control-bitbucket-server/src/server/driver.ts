import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { definition } from "../shared/definition.ts";
import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import * as BitbucketServerPullRequestApi from "./BitbucketServerPullRequestApi.ts";
import * as BitbucketServerPullRequestProvider from "./BitbucketServerPullRequestProvider.ts";
import * as BitbucketServerSourceControlProvider from "./BitbucketServerSourceControlProvider.ts";

const services = BitbucketServerPullRequestApi.layer.pipe(
  Layer.provideMerge(BitbucketServerApi.layer),
  Layer.orDie,
);
export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(
    Effect.all({
      sourceControl: BitbucketServerSourceControlProvider.make,
      discovery: BitbucketServerSourceControlProvider.makeDiscovery,
      pullRequests: BitbucketServerPullRequestProvider.make,
    }),
    services,
  ),
});
