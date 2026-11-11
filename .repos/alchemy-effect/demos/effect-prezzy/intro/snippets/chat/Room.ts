import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { History } from "./History.ts";

// #region show
export default class Room extends Cloudflare.DurableObject<Room>()(
  "Room",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // #region history
    const history = yield* History;
    // #endregion history

    return Effect.gen(function* () {
      return {
        // #region connect
        fetch: Effect.gen(function* () {
          const [response] = yield* Cloudflare.upgrade();
          return response;
        }),
        // #endregion connect
        // #region message
        webSocketMessage: Effect.fn(function* (_from, text) {
          // #region broadcast
          for (const socket of yield* state.getWebSockets()) {
            yield* socket.send(text);
          }
          // #endregion broadcast
          // #region send
          yield* history.append(state.id.name!, text);
          // #endregion send
        }),
        // #endregion message
      };
    });
  }),
) {}
// #endregion show
