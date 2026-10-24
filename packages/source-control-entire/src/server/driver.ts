import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as EntirePullRequestProvider from "./EntirePullRequestProvider.ts";
import * as EntireSourceControlProvider from "./EntireSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("entire"),
  make: Effect.all({
    sourceControl: EntireSourceControlProvider.make,
    discovery: EntireSourceControlProvider.makeDiscovery,
    pullRequests: EntirePullRequestProvider.make,
  }),
});
