import * as Effect from "effect/Effect";
import * as RpcServer from "./RpcServer.ts";
import { SESSION_ENV_PARAM } from "./RpcServerEnvironment.ts";
import type { ServerRpcSession } from "./RpcServerSession.ts";

export const RpcServerBun = RpcServer.layerServer(
  Effect.fn(function* ({
    parentConnected,
    parentDisconnected,
    createRpcSession,
  }) {
    const server = yield* Effect.sync(() =>
      Bun.serve<
        | { type: "session"; session: ServerRpcSession<any> }
        | { type: "pending"; sessionEnv: string | undefined }
        | { type: "parent" }
      >({
        port: 0,
        fetch: (request, server) => {
          const url = new URL(request.url);
          if (
            server.upgrade(request, {
              data:
                url.pathname === "/parent"
                  ? { type: "parent" }
                  : {
                      type: "pending",
                      sessionEnv:
                        url.searchParams.get(SESSION_ENV_PARAM) ?? undefined,
                    },
            })
          ) {
            return;
          }
          return new Response("Upgrade failed", { status: 400 });
        },
        websocket: {
          open: (ws) => {
            if (ws.data && ws.data.type === "parent") {
              parentConnected();
            } else {
              const sessionEnv =
                ws.data && ws.data.type === "pending"
                  ? ws.data.sessionEnv
                  : undefined;
              ws.data = {
                type: "session",
                session: createRpcSession(ws, sessionEnv),
              };
            }
          },
          message: (ws, message) => {
            if (ws.data.type === "session") {
              ws.data.session.dispatch.message(message);
            }
          },
          close: (ws, code, reason) => {
            if (ws.data.type === "session") {
              ws.data.session.dispatch.close(code, reason);
            } else if (ws.data.type === "parent") {
              parentDisconnected();
            }
          },
        },
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
    return {
      url: `ws://${server.hostname}:${server.port}`,
    };
  }),
);
