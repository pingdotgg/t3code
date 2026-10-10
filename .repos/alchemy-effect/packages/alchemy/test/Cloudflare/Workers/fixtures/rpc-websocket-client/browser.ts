import * as RpcWebSocketClient from "alchemy/Cloudflare/RpcWebSocketClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Socket from "effect/socket/Socket";
import { BrowserRpcs } from "./rpcs.ts";

export class BrowserClient extends Context.Service<BrowserClient>()(
  "RpcWebSocketBrowserClient",
  { make: RpcClient.make(BrowserRpcs) },
) {}

export const clientLayer = RpcWebSocketClient.layer(
  BrowserClient,
  BrowserRpcs,
  "wss://example.com/rpc",
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));

export const echo = (value: string) =>
  Effect.gen(function* () {
    const client = yield* BrowserClient;
    return yield* client.echo({ value });
  }).pipe(Effect.provide(clientLayer));
