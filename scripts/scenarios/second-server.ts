// A second T3 server for scenarios that need another machine: its own T3 home, the replay
// agent, and a pairing token for Settings > Connections > Add environment.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { ScenarioError } from "./shell.ts";
import { prepareHome, start } from "./start-app.ts";

export const SECOND_HOME = `${T3_HOME}-second-environment`;

interface SecondServerOptions {
  readonly home?: string;
  readonly nodeArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** A second server on its own T3 home, running until interrupted. `--dev-url` admits the web
 * origin through CORS and registers the replay agent; `paired` gets the Add environment input. */
const runSecondServer = Effect.fn("scenario.secondServer")(function* (
  devUrl: string,
  paired: (target: { readonly host: string; readonly token: string }) => void,
  { home = SECOND_HOME, nodeArgs = [], env }: SecondServerOptions,
) {
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const hostEnvironment = yield* HostProcess.Environment;
  const port = yield* (yield* NetService.NetService).reserveLoopbackPort();
  yield* prepareHome(home);
  const token = yield* Deferred.make<string>();
  const server = yield* start({
    cwd: APP_DIR,
    command: node,
    args: [
      ...nodeArgs,
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      home,
      "--dev-url",
      devUrl,
    ],
    env: {
      PATH: `${path.join(home, "bin")}:${hostEnvironment.PATH ?? ""}`,
      HOME: hostEnvironment.HOME,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
      ...env,
    },
    onLine: (line) => {
      const value = /^Token:\s*(\S+)/.exec(line)?.[1];
      return value === undefined ? Effect.void : Deferred.succeed(token, value).pipe(Effect.asVoid);
    },
  });
  // A server that exits before printing its token never will: fail instead of waiting forever.
  const exited = server.exitCode.pipe(
    Effect.flatMap(
      (code) =>
        new ScenarioError({ message: `The second server exited with code ${code} at startup.` }),
    ),
  );
  paired({
    host: `http://127.0.0.1:${port}`,
    token: yield* Effect.raceFirst(Deferred.await(token), exited),
  });
  return yield* Effect.never;
});

/** Starts the second server for the web app at `devUrl`. `ready` settles with its pairing input. */
export function startSecondServer(devUrl: string, options: SecondServerOptions = {}) {
  const pairing = Promise.withResolvers<{ readonly host: string; readonly token: string }>();
  const server = Effect.runFork(
    runSecondServer(devUrl, pairing.resolve, options).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NetService.layer]),
    ),
  );
  server.addObserver((exit) =>
    pairing.reject(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : new Error("The second server stopped."),
    ),
  );
  return { ready: pairing.promise, stop: () => Effect.runPromise(Fiber.interrupt(server)) };
}
