import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RestartObject } from "./object.ts";

/**
 * Drives the restart scenarios over HTTP. Each request targets a named DO
 * instance (`?name=`) so tests can isolate instances:
 *  - `GET /ping`    → RPC ping (starts/restarts the container, returns "pong")
 *  - `GET /running` → `{ running }`
 *  - `GET /stop`    → destroy the container (SIGKILL)
 *  - `GET /crash`   → make the container process exit non-zero
 */
export default Cloudflare.Worker(
  "RestartWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const objects = yield* RestartObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";
        const object = objects.getByName(name);

        if (url.pathname === "/ping") {
          const pong = yield* object.ping();
          return HttpServerResponse.text(pong);
        }
        if (url.pathname === "/running") {
          const running = yield* object.running();
          return yield* HttpServerResponse.json({ running });
        }
        if (url.pathname === "/stop") {
          yield* object.stop();
          return HttpServerResponse.text("stopped");
        }
        if (url.pathname === "/crash") {
          const result = yield* object.crash();
          return HttpServerResponse.text(result);
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        // Surface failures as 5xx (not a thrown defect) so the test's readiness
        // retry treats a mid-restart blip as retryable rather than fatal.
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(String(cause), { status: 503 }),
          ),
        ),
      ),
    };
  }),
);
