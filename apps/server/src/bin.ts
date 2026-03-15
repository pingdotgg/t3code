import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@t3tools/shared/Net";
import { cli } from "./cli";
import { version } from "../package.json" with { type: "json" };

Command.run(cli, { version }).pipe(
  Effect.provide(Layer.mergeAll(NetService.layer, NodeServices.layer)),
  NodeRuntime.runMain,
);
