/**
 * The Cursor Origin driver: repository operations, discovery, and pull requests through Origin's
 * REST API, signed in with the `origin` CLI's session.
 *
 * @module source-control-cursor-origin/server/driver
 */
import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

import * as OriginCli from "./OriginCli.ts";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const makeInstance = Effect.all({
  sourceControl: OriginSourceControlProvider.make,
  discovery: OriginSourceControlProvider.makeDiscovery,
  pullRequests: OriginPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, OriginCli.layer),
});
