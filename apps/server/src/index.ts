import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfigLive, makeCliCommand } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./wsServer";

const RuntimeLayer = Layer.provideMerge(
  Layer.mergeAll(CliConfigLive, ServerLive, OpenLive),
  NodeServices.layer,
);

Command.run(makeCliCommand(), { version }).pipe(Effect.provide(RuntimeLayer), NodeRuntime.runMain);
