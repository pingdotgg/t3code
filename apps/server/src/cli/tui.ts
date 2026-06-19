import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { Command, GlobalFlag } from "effect/unstable/cli";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** Mirror of the server's accepted websocket-ticket query parameter. */
const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

/** Build the `ws(s)://host:port/ws?wsTicket=…` URL from the server origin. */
function buildSocketUrl(origin: string, ticket: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams([[WEBSOCKET_TICKET_QUERY_PARAM, ticket]]).toString();
  return url.toString();
}

export const tuiCommand = Command.make("tui", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Open a terminal UI for the running local T3 Code server (no port forwarding required).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);

      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        yield* Console.error(
          "No running T3 Code server was found. Start one with `t3 serve` (or `t3 start`) first.",
        );
        return;
      }
      const origin = runtimeState.value.origin;

      // The TUI package is pure UI — it never touches the server's auth internals.
      // We do the loopback bootstrap here (inside the server, where EnvironmentAuth
      // is available): issue one long-lived bearer session, then hand the UI a
      // `mintSocketUrl` that re-mints a short-lived websocket ticket per connect.
      const authRuntime = ManagedRuntime.make(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(Layer.succeed(ServerConfig, config)),
          Layer.provideMerge(NodeServices.layer),
        ),
      );

      const issued = yield* Effect.promise(() =>
        authRuntime.runPromise(
          Effect.gen(function* () {
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            return yield* auth.issueSession({
              scopes: AuthStandardClientScopes,
              subject: "t3-tui",
              label: "T3 Code TUI",
              ttl: Duration.days(30),
            });
          }),
        ),
      );

      const mintSocketUrl = () =>
        authRuntime.runPromise(
          Effect.gen(function* () {
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            const result = yield* auth.issueWebSocketTicket({ sessionId: issued.sessionId });
            return buildSocketUrl(origin, result.ticket);
          }),
        );

      // Lazy-load the Ink UI so that `react`/`ink`/`@t3tools/tui` only load for
      // `t3 tui`, keeping the regular server startup path untouched.
      const { runTui } = yield* Effect.promise(() => import("@t3tools/tui"));
      yield* Effect.promise(() =>
        runTui({
          origin,
          bearerToken: issued.token,
          mintSocketUrl,
          logPath: `${config.serverRuntimeStatePath}.tui.log`,
        }),
      ).pipe(Effect.ensuring(Effect.promise(() => authRuntime.dispose())));
    }),
  ),
);
