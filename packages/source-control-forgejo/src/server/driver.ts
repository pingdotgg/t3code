import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const services = ForgejoCli.layer;

const makeInstance = Effect.all({
  sourceControl: ForgejoSourceControlProvider.make,
  discovery: ForgejoSourceControlProvider.makeDiscovery,
  pullRequests: ForgejoPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
