import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { sharedServerCommandFlags } from "./cli/config.ts";

export async function runLightCli(
  command: "pair" | "auth" | "service" | "project" | "serve" | "start",
) {
  const selected =
    command === "pair"
      ? (await import("./cli/pair.ts")).pairCommand
      : command === "auth"
        ? (await import("./cli/auth.ts")).authCommand
        : command === "service"
          ? (await import("./cli/service.ts")).serviceCommand
          : command === "project"
            ? (await import("./cli/project.ts")).projectCommand
            : command === "serve"
              ? (await import("./cli/server.ts")).serveCommand
              : (await import("./cli/server.ts")).startCommand;
  const cli = Command.make("t3", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the T3 Code server."),
    Command.withSubcommands([selected]),
  );
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    NodeRuntime.runMain,
  );
}
