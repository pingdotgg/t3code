import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

import * as RadicleCli from "./RadicleCli.ts";
import * as RadiclePullRequestProvider from "./RadiclePullRequestProvider.ts";
import * as RadicleSourceControlProvider from "./RadicleSourceControlProvider.ts";

const makeInstance = Effect.all({
  sourceControl: RadicleSourceControlProvider.make,
  discovery: RadicleSourceControlProvider.makeDiscovery,
  pullRequests: RadiclePullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, RadicleCli.layer),
});
