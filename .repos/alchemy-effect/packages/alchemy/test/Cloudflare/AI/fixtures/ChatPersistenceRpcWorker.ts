import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import ChatBackendRpc from "./ChatBackendRpc.ts";
import { ChatRpcs } from "./ChatRpcs.ts";

// Same role as `ChatPersistenceWorker` (host the chat DO, route by
// thread id) but the whole `fetch` surface is a typed Effect
// `RpcGroup`. Each procedure proxies straight through the typed
// `getByName(id)` client returned by `RpcDurableObject`.
export default class ChatPersistenceRpcWorker extends Cloudflare.RpcWorker<ChatPersistenceRpcWorker>()(
  "ChatPersistenceRpcWorker",
  {
    main: import.meta.url,
    schema: ChatRpcs,
  },
  Effect.gen(function* () {
    // Yielding the inline DO hosts it on this Worker and hands back the
    // typed namespace.
    const chats = yield* ChatBackendRpc;

    const handlers = ChatRpcs.toLayer({
      send: ({ id, prompt }) =>
        Effect.flatMap(chats.getByName(id), (client) =>
          client.send({ prompt }),
        ).pipe(Effect.orDie),
      streamMessage: ({ id, prompt }) =>
        chats.getByName(id).pipe(
          Effect.map((client) => client.streamMessage({ prompt })),
          Stream.unwrap,
          Stream.orDie,
        ),
    });

    return RpcServer.toHttpEffect(ChatRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
