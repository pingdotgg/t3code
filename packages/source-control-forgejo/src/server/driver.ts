/**
 * The Forgejo / Gitea driver: repository operations, discovery, and pull requests through
 * `fj` or `tea`.
 *
 * @module source-control-forgejo/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: "forgejo",
  make: Effect.all({
    sourceControl: ForgejoSourceControlProvider.make,
    discovery: ForgejoSourceControlProvider.makeDiscovery,
    pullRequests: ForgejoPullRequestProvider.make,
  }),
});
