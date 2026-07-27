import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Minimal effectful container for exercising stop/crash → auto-restart. `ping`
 * proves the container is up; the `/exit` route makes the container process
 * kill itself (non-zero exit) so we can drive the monitor-observed-crash path.
 */
export class RestartContainer extends Cloudflare.Container<
  RestartContainer,
  {
    ping: () => Effect.Effect<string>;
  }
>()("RestartContainer") {}

export default RestartContainer.make(
  {
    main: import.meta.filename,
    image: "oven/bun:latest",
  },
  Effect.gen(function* () {
    return {
      ping: () => Effect.succeed("pong"),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname === "/exit") {
          // Simulate a crash: kill the container process with a non-zero exit
          // code shortly after replying, so the response flushes first. The
          // Durable Object's monitor observes the exit; the next request must
          // transparently restart the container.
          yield* Effect.sync(() => {
            setTimeout(() => process.exit(1), 50);
          });
          return HttpServerResponse.text("exiting");
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }),
);
