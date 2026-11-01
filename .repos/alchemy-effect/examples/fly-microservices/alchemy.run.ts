/**
 * Three Services connected over a private Fly network:
 *
 * - `Users` — private, serves `list` and `get` methods (`src/users.ts`)
 * - `Orders` — private, binds Users (`src/orders.ts`)
 * - `Gateway` — the only public Service, binds both (`src/gateway.ts`)
 *
 * Each Service is its own Fly App. All three join `Fly.stackNetwork`, a
 * private network unique to this stack and stage, so Users and Orders are
 * unreachable from the internet and from every other App in the org.
 * `Fly.bindService` connects them: only a Service that binds another
 * receives its caller token, so it can call its methods.
 */
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Gateway from "./src/gateway.ts";
import Orders from "./src/orders.ts";
import Users from "./src/users.ts";

export default Alchemy.Stack(
  "FlyMicroservices",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const users = yield* Users;
    const orders = yield* Orders;
    const gateway = yield* Gateway;

    return {
      url: gateway.url,
      network: gateway.network,
      usersUrl: users.url,
      usersPrivateUrl: users.privateUrl,
      ordersPrivateUrl: orders.privateUrl,
    };
  }),
);
