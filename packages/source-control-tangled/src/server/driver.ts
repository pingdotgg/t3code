import { SourceControlProviderKind } from "@t3tools/contracts";
/**
 * The Tangled driver: repository operations and pull requests through the `tg` CLI, and default
 * branches through git. Pull requests are listed, read and summarised; nothing is written to one.
 *
 * @module source-control-tangled/server/driver
 */
import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";
import * as TangledCli from "./TangledCli.ts";

import * as TangledPullRequestProvider from "./TangledPullRequestProvider.ts";
import * as TangledSourceControlProvider from "./TangledSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("tangled"),
  definition,
  make: withOwnServices(
    Effect.all({
      sourceControl: TangledSourceControlProvider.make,
      discovery: Effect.succeed(TangledSourceControlProvider.discovery),
      pullRequests: TangledPullRequestProvider.make,
    }),
    TangledCli.layer,
  ),
});
