import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Orders from "./orders.ts";
import Users from "./users.ts";

/**
 * The only public Service. It joins the same network as {@link Users} and
 * {@link Orders}, binds both, and serves `/users` and `/orders`.
 */
export default class Gateway extends Fly.Service<Gateway>()(
  "Gateway",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      network: yield* Fly.stackNetwork,
    };
  }),
  Effect.gen(function* () {
    const users = yield* Fly.bindService(Users);
    const orders = yield* Fly.bindService(Orders);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://gateway").pathname;
        if (path === "/users") {
          return yield* HttpServerResponse.json(yield* users.list());
        }
        if (path === "/orders") {
          return yield* HttpServerResponse.json(yield* orders.list());
        }
        return HttpServerResponse.text("try /users or /orders");
      }).pipe(Effect.orDie),
    };
  }),
) {}
