import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as EntireApi from "./EntireApi.ts";
import * as EntireCli from "./EntireCli.ts";
import * as EntirePullRequestProvider from "./EntirePullRequestProvider.ts";
import * as EntireSourceControlProvider from "./EntireSourceControlProvider.ts";

const services = EntireApi.layer.pipe(Layer.provideMerge(EntireCli.layer));

const makeInstance = Effect.all({
  sourceControl: EntireSourceControlProvider.make,
  discovery: EntireSourceControlProvider.makeDiscovery,
  pullRequests: EntirePullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
