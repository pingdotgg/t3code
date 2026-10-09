import * as Fly from "@/Fly";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Ping, Pong } from "./rpc-cycle.ts";

export default Ping.make(
  {
    main: import.meta.url,
    region: "iad",
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const pong = yield* Fly.bindService(Pong);
    return {
      name: () => Effect.succeed("ping"),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(`ping hears ${yield* pong.name()}`);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 502 }),
          ),
        ),
      ),
    };
  }),
);
