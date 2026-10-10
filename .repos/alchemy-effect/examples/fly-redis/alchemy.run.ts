/**
 * Fly.io Upstash Redis attached to an HTTP Service.
 *
 * Redis is not reachable from CI — the Service PING's it over 6PN
 * and exposes `{ pong: true }` at `/`.
 */
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Cache } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyRedis",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cache = yield* Cache;
    const api = yield* Api;

    return {
      appName: api.appName,
      redisId: cache.redisId,
      redisName: cache.name,
      apiUrl: api.url,
    };
  }),
);
