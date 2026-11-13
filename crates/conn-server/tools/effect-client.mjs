// Calls a running conn-server with Effect's own RpcClient (WebSocket + JSON), as Conn does.
// Run after `vp i`:  node native/conn-server/crates/conn-server/tools/effect-client.mjs http://127.0.0.1:<port>
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const contracts = new URL("../../../../../packages/contracts/", import.meta.url);
const resolve = NodeModule.createRequire(new URL("package.json", contracts)).resolve;
const load = (specifier) => import(NodeURL.pathToFileURL(resolve(specifier)).href);
const Effect = await load("effect/Effect");
const Layer = await load("effect/Layer");
const Exit = await load("effect/Exit");
const { RpcClient, RpcSerialization } = await load("effect/rpc");
const Socket = await load("effect/socket/Socket");
const { WsRpcGroup } = await import(new URL("src/rpc.ts", contracts).href);

const base = process.argv[2];
if (!base) throw new Error("usage: effect-client.mjs http://127.0.0.1:<port>");
const url = `${base.replace(/^http/, "ws")}/ws`;

const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const probe = yield* client["server.probe"]({});
  console.log("server.probe ->", JSON.stringify(probe));
  const missing = yield* Effect.exit(client["server.getConfig"]({}));
  console.log(
    "server.getConfig ->",
    Exit.isFailure(missing) ? String(missing.cause) : "unexpected success",
  );
}).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("5 seconds"));

await Effect.runPromise(program);
