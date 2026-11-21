import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as TanStackSourceCredentials from "./TanStackSourceCredentials.ts";
import * as TanStackSourceIssueTracker from "./TanStackSourceIssueTracker.ts";
import * as TanStackSourcePullRequestProvider from "./TanStackSourcePullRequestProvider.ts";
import * as TanStackSourceSourceControlProvider from "./TanStackSourceSourceControlProvider.ts";

const services = TanStackSourceApi.layer.pipe(Layer.provideMerge(TanStackSourceCredentials.layer));

const makeInstance = Effect.all({
  sourceControl: TanStackSourceSourceControlProvider.make,
  discovery: TanStackSourceSourceControlProvider.makeDiscovery,
  pullRequests: TanStackSourcePullRequestProvider.make,
  issues: TanStackSourceIssueTracker.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
