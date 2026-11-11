import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

/**
 * One instance per short link: keeps the click count in transactional
 * storage and pushes every change to the dashboards watching it over
 * hibernatable WebSockets.
 */
export default class LinkRoom extends Cloudflare.DurableObject<LinkRoom>()(
  "LinkRoom",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      let clicks = (yield* state.storage.get<number>("clicks")) ?? 0;

      const broadcast = Effect.fn(function* () {
        for (const socket of yield* state.getWebSockets()) {
          yield* socket.send(JSON.stringify({ clicks }));
        }
      });

      return {
        record: Effect.fn(function* (n: number) {
          clicks += n;
          yield* state.storage.put("clicks", clicks);
          yield* broadcast();
          return clicks;
        }),
        clicks: () => Effect.succeed(clicks),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* socket.send(JSON.stringify({ clicks }));
          return response;
        }),
      };
    });
  }),
) {}
