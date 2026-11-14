import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

const isCliError = Schema.is(ForgejoCli.ForgejoCliError);

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
  rateLimitRefusal: (error) =>
    isCliError(error) && error.reason === "rate-limit" ? {} : undefined,
});
