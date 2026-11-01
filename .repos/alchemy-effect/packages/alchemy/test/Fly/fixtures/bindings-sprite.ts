import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class BindingsSprite extends Fly.Sprite<BindingsSprite>()(
  "BindingsSprite",
  { main: import.meta.url, port: 3000 },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
) {}
