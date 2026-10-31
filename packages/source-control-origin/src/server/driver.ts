import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as OriginApi from "./OriginApi.ts";
import * as OriginCredentials from "./OriginCredentials.ts";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const services = OriginApi.layer.pipe(Layer.provideMerge(OriginCredentials.layer));

const makeInstance = Effect.all({
  sourceControl: OriginSourceControlProvider.make,
  discovery: OriginSourceControlProvider.makeDiscovery,
  pullRequests: OriginPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
