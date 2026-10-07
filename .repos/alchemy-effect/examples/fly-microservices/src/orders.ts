import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Users from "./users.ts";

const ORDERS = [
  { id: "o1", userId: "u1", item: "keyboard" },
  { id: "o2", userId: "u2", item: "monitor" },
];

/**
 * Private Service that calls {@link Users} through a binding. Binding
 * `Users` makes Orders deploy after it and hands Orders a typed client.
 */
export default class Orders extends Fly.Service<Orders>()(
  "Orders",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      public: false,
      network: yield* Fly.stackNetwork,
    };
  }),
  Effect.gen(function* () {
    const users = yield* Fly.bindService(Users);
    return {
      list: () =>
        Effect.forEach(ORDERS, (order) =>
          users
            .get(order.userId)
            .pipe(Effect.map((user) => ({ ...order, user }))),
        ),
    };
  }),
) {}
