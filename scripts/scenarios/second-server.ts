// A second T3 server for scenarios that need another machine: its own T3 home, the replay
// agent, and a pairing token for Settings > Connections > Add environment.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { prepareHome, start } from "./start-app.ts";

export const SECOND_HOME = `${T3_HOME}-second-environment`;

/** A second server on its own T3 home, running until interrupted. `--dev-url` admits the web
 * origin through CORS and registers the replay agent; `paired` gets the Add environment input. */
const runSecondServer = Effect.fn("scenario.secondServer")(function* (
  devUrl: string,
  paired: (target: { readonly host: string; readonly token: string }) => void,
) {
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const hostEnvironment = yield* HostProcess.Environment;
  const port = yield* (yield* NetService.NetService).reserveLoopbackPort();
  yield* prepareHome(SECOND_HOME);
  const token = yield* Deferred.make<string>();
  yield* start({
    cwd: APP_DIR,
    command: node,
    args: [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      SECOND_HOME,
      "--dev-url",
      devUrl,
    ],
    env: {
      PATH: `${path.join(SECOND_HOME, "bin")}:${hostEnvironment.PATH ?? ""}`,
      HOME: hostEnvironment.HOME,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    },
    onLine: (line) => {
      const value = /^Token:\s*(\S+)/.exec(line)?.[1];
      return value === undefined ? Effect.void : Deferred.succeed(token, value).pipe(Effect.asVoid);
    },
  });
  paired({ host: `http://127.0.0.1:${port}`, token: yield* Deferred.await(token) });
  return yield* Effect.never;
});

/** Starts the second server for the web app at `devUrl`. `ready` settles with its pairing input. */
export function startSecondServer(devUrl: string) {
  const pairing = Promise.withResolvers<{ readonly host: string; readonly token: string }>();
  const server = Effect.runFork(
    runSecondServer(devUrl, pairing.resolve).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, NetService.layer]),
    ),
  );
  server.addObserver(() => pairing.reject(new Error("The second server stopped.")));
  return { ready: pairing.promise, stop: () => Effect.runPromise(Fiber.interrupt(server)) };
}
