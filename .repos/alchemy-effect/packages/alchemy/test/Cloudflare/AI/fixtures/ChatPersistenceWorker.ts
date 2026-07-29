import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ChatBackend from "./ChatBackend.ts";

export default class ChatPersistenceTestWorker extends Cloudflare.Worker<ChatPersistenceTestWorker>()(
  "ChatPersistenceTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // Yielding the inline DO hosts it on this Worker and hands back the
    // namespace handle.
    const chats = yield* ChatBackend;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "default";
        const prompt = url.searchParams.get("prompt") ?? "Say pong.";

        if (url.pathname === "/chat") {
          const result = yield* chats.getByName(id).send(id, prompt);
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
