// @effect-diagnostics nodeBuiltinImport:off - the server entrypoint owns Node runtime compatibility.
import * as NodeNet from "node:net";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { connectCommand } from "./cli/connect.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { isEntrypoint } from "./entrypoint.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { themeCommand } from "./cli/theme.ts";
import { triageCommand } from "./cli/triage.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

type SetTypeOfService = (this: NodeNet.Socket, typeOfService: number) => NodeNet.Socket;

type SocketPrototypeWithTypeOfService = NodeNet.Socket & {
  setTypeOfService?: SetTypeOfService;
};

export const guardSetTypeOfService = (setTypeOfService: SetTypeOfService): SetTypeOfService =>
  function guardedSetTypeOfService(this: NodeNet.Socket, typeOfService: number): NodeNet.Socket {
    try {
      return setTypeOfService.call(this, typeOfService);
    } catch (cause) {
      // Node 24's bundled Undici applies best-effort QoS to every request. macOS
      // can reject that socket option during reuse; the request itself remains valid.
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "EINVAL"
      ) {
        return this;
      }
      throw cause;
    }
  };

const installNodeNetworkCompatibility = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform !== "darwin") return;

  const socketPrototype = NodeNet.Socket.prototype as SocketPrototypeWithTypeOfService;
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (typeof setTypeOfService !== "function") return;

  socketPrototype.setTypeOfService = guardSetTypeOfService(setTypeOfService);
});

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect", {
  command: Argument.string("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription("T3 Connect is unavailable in builds without public configuration."),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["t3", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  Command.make("t3", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the T3 Code server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      servicePreflightCommand,
      themeCommand,
      triageCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
    ]),
  );

export const cli = makeCli();

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  installNodeNetworkCompatibility.pipe(
    Effect.andThen(Command.run(cli, { version: packageJson.version })),
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
