import * as Effect from "effect/Effect";
import { WebSocketServer, type Server } from "ws";
import * as RpcServer from "./RpcServer.ts";

export const RpcServerNode = RpcServer.layerServer(
  Effect.fn(function* ({
    parentConnected,
    parentDisconnected,
    createRpcSession,
  }) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const url = yield* Effect.callback<string>((resume) => {
      server.on("connection", (ws, req) => {
        if (req.url?.startsWith("/parent")) {
          parentConnected();
          ws.on("close", () => {
            parentDisconnected();
          });
          return;
        }
        const session = createRpcSession(ws);
        ws.on("message", (data) => {
          session.dispatch.message(data.toString());
        });
        ws.on("close", (code, reason) => {
          session.dispatch.close(code, reason.toString());
        });
      });
      server.on("error", (error) => {
        resume(Effect.die(error));
      });
      server.on("listening", () => {
        resume(getServerAddress(server));
      });
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
    return { url };
  }),
);

function getServerAddress(server: Server): Effect.Effect<string> {
  const address = server.address();
  if (
    typeof address === "object" &&
    address !== null &&
    "address" in address &&
    "port" in address
  ) {
    return Effect.succeed(
      `ws://${address.address === "::" ? "localhost" : address.address}:${address.port}`,
    );
  }
  return Effect.die(
    new Error(
      `Server address is not an object with address and port properties: ${JSON.stringify(address)}`,
    ),
  );
}
