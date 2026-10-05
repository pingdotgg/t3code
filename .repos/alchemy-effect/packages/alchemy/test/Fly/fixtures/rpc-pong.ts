import * as Fly from "@/Fly";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Pong, Ping } from "./rpc-cycle.ts";

export default Pong.make(
  {
    main: import.meta.url,
    region: "iad",
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const ping = yield* Fly.bindService(Ping);
    return {
      name: () => Effect.succeed("pong"),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(`pong hears ${yield* ping.name()}`);
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
