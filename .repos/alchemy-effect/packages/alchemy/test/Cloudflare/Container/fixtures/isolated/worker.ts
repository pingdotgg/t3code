import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { IsolatedObject } from "./object.ts";

/**
 * Drives the container over HTTP: `GET /ping` → RPC ping, `GET /hello` →
 * the container's own HTTP server through its TCP port.
 */
export default Cloudflare.Worker(
  "IsolatedProjectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const objects = yield* IsolatedObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName("default");

        if (url.pathname === "/ping") {
          const pong = yield* object.ping();
          return HttpServerResponse.text(pong);
        }
        if (url.pathname === "/hello") {
          const text = yield* object.hello();
          return HttpServerResponse.text(text);
        }
        return HttpServerResponse.text("ok");
      }).pipe(
        // Surface failures as 5xx (not a thrown defect) so the test's
        // readiness retry treats a container that is still starting as
        // retryable rather than fatal.
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(String(cause), { status: 503 }),
          ),
        ),
      ),
    };
  }),
);
