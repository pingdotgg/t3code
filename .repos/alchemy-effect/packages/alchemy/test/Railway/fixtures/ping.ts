import { Function } from "@/Railway/Function.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Partition, Site } from "./suite-env.ts";

export { Site };

/**
 * Effect-native Railway.Function: bundled into a single file and
 * deployed as a canvas Function. No Docker. No registry.
 */
export default class Ping extends Function<Ping>()(
  "Ping",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
