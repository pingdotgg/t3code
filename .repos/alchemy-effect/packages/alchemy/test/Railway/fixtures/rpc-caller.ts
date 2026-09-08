import { bindFunction } from "@/Railway/Bind.ts";
import { Function } from "@/Railway/Function.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Greeter from "./rpc-greeter.ts";
import { Partition, Site } from "./rpc-shared.ts";

/**
 * Tagged Function that binds {@link Greeter} and calls `.greet` over the
 * private mesh. Public fetch is the only way a laptop can observe the
 * trusted call.
 */
export default class Caller extends Function<Caller>()(
  "Caller",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const greeter = yield* bindFunction(Greeter);
    return {
      fetch: greeter
        .greet("sam")
        .pipe(Effect.map((greeting) => HttpServerResponse.text(greeting))),
    };
  }),
) {}
