import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@t3tools/shared/Net";
import { cli } from "./cli.ts";
import packageJson from "../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  NodeRuntime.runMain,
);
