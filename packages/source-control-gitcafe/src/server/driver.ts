import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../client/definition.ts";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";
import * as GitCafeSourceControlProvider from "./GitCafeSourceControlProvider.ts";

const services = GitCafeApi.layer.pipe(Layer.provideMerge(GitCafeCredentials.layer));

/** Over this host's own services, which `driver` builds; tests stand in for them. */
export const makeInstance = Effect.all({
  sourceControl: GitCafeSourceControlProvider.make,
  discovery: GitCafeSourceControlProvider.makeDiscovery,
  pullRequests: GitCafePullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
