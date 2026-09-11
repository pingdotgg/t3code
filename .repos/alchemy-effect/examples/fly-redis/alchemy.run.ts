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
import { Cache, PublicIp, Site } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyRedis",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const cache = yield* Cache;
    const ip = yield* PublicIp;
    const api = yield* Api;

    return {
      appName: site.appName,
      appUrl: site.url,
      redisId: cache.redisId,
      redisName: cache.name,
      ip: ip.ip,
      apiUrl: api.url,
    };
  }),
);
