/**
 * A Fly.io Sprite that exercises the Platform class form:
 *
 * - `Box` — HTTP Sprite (`src/box.ts`)
 *
 * A Sprite is org-scoped. There is no parent App. Alchemy bundles
 * `main` and runs it on the Sprite. Auth is FLY_API_TOKEN.
 */
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Box from "./src/box.ts";

export default Alchemy.Stack(
  "FlySprite",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const box = yield* Box;

    return {
      spriteId: box.spriteId,
      name: box.name,
      url: box.url,
      status: box.status,
      urlAuth: box.urlAuth,
    };
  }),
);
