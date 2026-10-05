import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Counters } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpMemorystoreRedisExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const counters = yield* Counters;
    const api = yield* Api;

    return {
      url: api.uri,
      serviceName: api.name,
      instanceName: counters.name,
      redisHost: counters.host,
    };
  }),
);
