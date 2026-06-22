import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

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

/** A websocket-url request sent by the Bun TUI child over the IPC channel. */
interface MintRequest {
  readonly type?: string;
  readonly id?: number;
}

/**
 * Run the Bun TUI subprocess. The OpenTUI renderer requires Bun, so the Node
 * `t3 tui` command (which holds the server's auth) bootstraps a session here and
 * spawns `bun <entry>`, then answers the child's websocket-ticket requests over
 * the Node IPC channel (fd 3). Resolves when the child exits, or immediately with
 * a hint if Bun isn't installed.
 */
function runBunTui(input: {
  readonly origin: string;
  readonly bearerToken: string;
  readonly logPath: string;
  readonly mintSocketUrl: () => Promise<string>;
}): Promise<void> {
  const bunCommand = process.env.T3_TUI_BUN ?? "bun";
  const tuiEntry = NodeModule.createRequire(import.meta.url).resolve("@t3tools/tui");

  return new Promise<void>((resolve) => {
    const child = NodeChildProcess.spawn(bunCommand, [tuiEntry], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        T3_TUI_ORIGIN: input.origin,
        T3_TUI_BEARER: input.bearerToken,
        T3_TUI_LOG: input.logPath,
      },
    });

    child.on("message", (message: MintRequest) => {
      if (message.type !== "mintSocketUrl" || typeof message.id !== "number") return;
      const id = message.id;
      input
        .mintSocketUrl()
        .then((url) => {
          if (child.connected) child.send({ type: "socketUrl", id, url });
        })
        .catch((error: unknown) => {
          if (child.connected) {
            child.send({ type: "socketUrl", id, url: null, error: String(error) });
          }
        });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        process.stderr.write(
          "`t3 tui` needs Bun to run its terminal UI. Install it from https://bun.sh " +
            "(or set T3_TUI_BUN to a bun binary).\n",
        );
      } else {
        process.stderr.write(`t3 tui: failed to start Bun: ${error.message}\n`);
      }
      resolve();
    });

    child.on("close", () => resolve());
  });
}

export const tuiCommand = Command.make("tui", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Open a terminal UI for the running local T3 Code server (requires Bun; no port forwarding).",
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

      // The TUI runs in a separate Bun process and never touches the server's
      // auth internals. We do the loopback bootstrap here: issue one long-lived
      // bearer session, then answer the child's per-connect websocket-ticket
      // requests over the IPC channel.
      const authRuntime = ManagedRuntime.make(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(Layer.succeed(ServerConfig, config)),
          Layer.provideMerge(NodeServices.layer),
        ),
      );

      // Track the issued session so the ensuring below can revoke it and dispose
      // the runtime even if issueSession itself fails — otherwise the runtime
      // (and its DB/secret resources) would leak.
      let issuedSession: EnvironmentAuth.IssuedBearerSession | null = null;

      yield* Effect.gen(function* () {
        const session = yield* Effect.promise(() =>
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
        issuedSession = session;

        const mintSocketUrl = () =>
          authRuntime.runPromise(
            Effect.gen(function* () {
              const auth = yield* EnvironmentAuth.EnvironmentAuth;
              const result = yield* auth.issueWebSocketTicket({ sessionId: session.sessionId });
              return buildSocketUrl(origin, result.ticket);
            }),
          );

        yield* Effect.promise(() =>
          runBunTui({
            origin,
            bearerToken: session.token,
            logPath: `${config.serverRuntimeStatePath}.tui.log`,
            mintSocketUrl,
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            const session = issuedSession;
            if (session) {
              // Best-effort: don't leave a 30-day session valid after the TUI quits.
              await authRuntime
                .runPromise(
                  Effect.gen(function* () {
                    const auth = yield* EnvironmentAuth.EnvironmentAuth;
                    yield* auth.revokeSession(session.sessionId);
                  }),
                )
                .catch(() => {});
            }
            await authRuntime.dispose();
          }),
        ),
      );
    }),
  ),
);
