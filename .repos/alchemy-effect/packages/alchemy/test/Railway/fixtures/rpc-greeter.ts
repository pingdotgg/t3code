import { Function } from "@/Railway/Function.ts";
import { enableRailwayRpc } from "@/Railway/rpc-server.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Partition, Site } from "./rpc-shared.ts";

export { Site };

/**
 * Tagged Function that hosts a schemaless `greet` method. RPC is served
 * only on `{name}.railway.internal` with `ALCHEMY_RPC_TOKEN`.
 */
export default class Greeter extends Function<Greeter>()(
  "Greeter",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    enableRailwayRpc();
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: Effect.succeed(HttpServerResponse.text("greeter")),
    };
  }),
) {}
