import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, t3Cli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./wsServer";
import { NetService } from "@t3tools/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";

const isBun = process.versions.bun !== undefined;
const platformServicesLayer = isBun ? BunServices.layer : NodeServices.layer;
const runMain = isBun ? BunRuntime.runMain : NodeRuntime.runMain;

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(platformServicesLayer),
  Layer.provideMerge(FetchHttpClient.layer),
);

Command.run(t3Cli, { version }).pipe(Effect.provide(RuntimeLayer), runMain);
