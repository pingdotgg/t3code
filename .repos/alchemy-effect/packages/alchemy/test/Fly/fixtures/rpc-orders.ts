import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import RpcUsers from "./rpc-users.ts";

export const ORDERS = [
  { id: "o1", userId: "u1", item: "keyboard" },
  { id: "o2", userId: "u2", item: "monitor" },
];

/** Private Service that calls {@link RpcUsers} through a binding. */
export default class RpcOrders extends Fly.Service<RpcOrders>()(
  "RpcOrders",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      region: "iad",
      public: false,
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
    };
  }),
  Effect.gen(function* () {
    const users = yield* Fly.bindService(RpcUsers);
    return {
      listOrders: () =>
        Effect.forEach(ORDERS, (order) =>
          users
            .getUser(order.userId)
            .pipe(Effect.map((user) => ({ ...order, user }))),
        ),
    };
  }),
) {}
