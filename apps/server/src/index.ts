import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, remoteAgentCli, t3Cli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./wsServer";
import { NetService } from "@t3tools/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const isRemoteAgentCommand = process.argv[2] === "remote-agent";
if (isRemoteAgentCommand) {
  process.argv.splice(2, 1);
  Command.run(remoteAgentCli, { version }).pipe(Effect.provide(RuntimeLayer), NodeRuntime.runMain);
} else {
  Command.run(t3Cli, { version }).pipe(Effect.provide(RuntimeLayer), NodeRuntime.runMain);
}
