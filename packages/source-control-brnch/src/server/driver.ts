import { SourceControlProviderKind } from "@t3tools/contracts";
/**
 * The Brnch driver: repositories and changes on brnch.io, all through the `brnch` CLI and git.
 *
 * @module source-control-brnch/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as BrnchPullRequestProvider from "./BrnchPullRequestProvider.ts";
import * as BrnchSourceControlProvider from "./BrnchSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("brnch"),
  make: Effect.all({
    sourceControl: BrnchSourceControlProvider.make,
    discovery: Effect.succeed(BrnchSourceControlProvider.discovery),
    pullRequests: BrnchPullRequestProvider.make,
  }),
});
