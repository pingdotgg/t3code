import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

// Node throws an uncaught exception — taking the whole process down — when a
// socket emits 'error' with no listener attached. @effect/platform-node's
// upgrade handler wires a 'close' listener on the raw upgrade socket but not an
// 'error' one, so a client that RSTs a /ws connection during or right after the
// handshake kills the server. Attaching a no-op 'error' listener on every
// upgrade socket turns the reset into a normal disconnect.
export const guardUpgradeSockets = (server: NodeHttp.Server): NodeHttp.Server => {
  server.on("upgrade", (_request, socket: NodeNet.Socket) => {
    socket.on("error", () => {});
  });
  return server;
};
