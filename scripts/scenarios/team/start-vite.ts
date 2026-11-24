#!/usr/bin/env node
// Starts a single shared Vite dev server for multi-member team E2E scenarios.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { start } from "../start-app.ts";

// Mirror of BASE_WEB_PORT in scripts/dev-runner.ts.
const BASE_WEB_PORT = 5733;

const runVite = Effect.fn("teamStartVite")(function* (input: {
  readonly host: string;
  readonly webPort: string;
}) {
  const net = yield* NetService.NetService;
  const node = yield* HostProcess.ExecutablePath;
  const checkout = yield* HostProcess.WorkingDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const dummyServerPort = String(yield* net.reserveLoopbackPort());
  const origin = `http://${input.host}:${input.webPort}`;
  const webEnv = {
    ...hostEnvironment,
    T3CODE_PORT_OFFSET: String(Number(input.webPort) - BASE_WEB_PORT),
  };
  const web = yield* start({
    cwd: checkout,
    command: node,
    args: [
      "scripts/dev-runner.ts",
      "dev:web",
      "--no-seed",
      "--port",
      dummyServerPort,
      "--dev-url",
      origin,
      "--",
      "--host",
      input.host,
    ],
    env: webEnv,
    onLine: Console.log,
  });
  return yield* web.exitCode;
});

const command = Command.make(
  "start-vite",
  {
    host: Argument.String("host"),
    webPort: Argument.String("webPort"),
  },
  ({ host, webPort }) => runVite({ host, webPort }),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([NodeServices.layer, NetService.layer]),
  NodeRuntime.runMain,
);
