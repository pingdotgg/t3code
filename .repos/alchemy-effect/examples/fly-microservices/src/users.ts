import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export interface User {
  id: string;
  name: string;
}

export const USERS: User[] = [
  { id: "u1", name: "Ada" },
  { id: "u2", name: "Grace" },
];

/**
 * Private Service. `public: false` gives it no internet address, and
 * `network: Fly.stackNetwork` puts it on a private network that only this
 * stage's Services join. It returns methods, which Services that bind it
 * with `Fly.bindService(Users)` call.
 */
export default class Users extends Fly.Service<Users>()(
  "Users",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      public: false,
      network: yield* Fly.stackNetwork,
    };
  }),
  Effect.gen(function* () {
    return {
      list: () => Effect.succeed(USERS),
      get: (id: string) => Effect.succeed(USERS.find((user) => user.id === id)),
    };
  }),
) {}
