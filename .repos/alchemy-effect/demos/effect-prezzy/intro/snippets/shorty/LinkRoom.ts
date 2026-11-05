import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

// #region show
export default class LinkRoom extends Cloudflare.DurableObject<LinkRoom>()(
  "LinkRoom",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // #region body
      // #region count
      let clicks = (yield* state.storage.get<number>("clicks")) ?? 0;
      // #endregion count

      return {
        // #region record
        record: Effect.fn(function* () {
          clicks += 1;
          yield* state.storage.put("clicks", clicks);
          // #region push
          for (const socket of yield* state.getWebSockets()) {
            yield* socket.send(JSON.stringify({ clicks }));
          }
          // #endregion push
        }),
        // #endregion record
        // #region socket
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* socket.send(JSON.stringify({ clicks }));
          return response;
        }),
        // #endregion socket
      };
      // #endregion body
    });
  }),
) {}
// #endregion show
