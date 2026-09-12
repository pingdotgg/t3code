import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ShellSession from "./shell-session.ts";
import { ShellMicrovm } from "./shell-image.ts";
import { TERMINAL_HTML } from "./terminal-html.ts";

/**
 * The cross-cloud shell Worker.
 *
 * - `GET /` serves the hand-rolled terminal SPA.
 * - `GET /session/:id/ws` provisions (or reuses) the session's AWS Lambda
 *   MicroVM, hands its endpoint + auth headers to the {@link ShellSession}
 *   Durable Object, and forwards the WebSocket upgrade to it.
 *
 * The MicroVM control-plane ops (Run/Get/CreateAuthToken) are bound on this
 * Worker — Alchemy mints an IAM User + AccessKey + assume-role Role once and
 * the Worker assumes it at runtime (see `MicrovmBinding.ts`). Under
 * `alchemy dev` the Worker runs in local workerd and these calls resolve to
 * the Floci emulator via the dev endpoint + CA wiring.
 */
export default Cloudflare.Worker(
  "MicrovmShellWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* ShellSession;
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(ShellMicrovm);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(ShellMicrovm);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(ShellMicrovm);

    /** Boot a MicroVM, wait until RUNNING, and mint a data-plane auth token. */
    const provision = Effect.gen(function* () {
      const vm = yield* runMicrovm({
        idlePolicy: {
          maxIdleDurationSeconds: 900,
          suspendedDurationSeconds: 300,
          autoResumeEnabled: true,
        },
      });
      yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
        Effect.flatMap((m) =>
          m.state === "RUNNING"
            ? Effect.void
            : Effect.fail(new Error(`microvm ${m.state}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
      );
      const { authToken } = yield* createAuthToken({
        microvmIdentifier: vm.microvmId,
        expirationInMinutes: 60,
        allowedPorts: [{ port: 8080 }],
      });
      return {
        endpoint: vm.endpoint,
        headers: AWS.Lambda.microvmAuthHeaders(authToken),
      };
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://shell");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.html(TERMINAL_HTML);
        }

        const wsMatch = url.pathname.match(/^\/session\/([^/]+)\/ws$/);
        if (wsMatch) {
          if (request.headers.upgrade !== "websocket") {
            return HttpServerResponse.text("expected websocket upgrade", {
              status: 426,
            });
          }
          const sessionId = wsMatch[1]!;
          const stub = sessions.getByName(sessionId);
          const coords = yield* provision;
          yield* stub.init(coords);
          return yield* stub.fetch(request);
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
      ),
    ),
  ),
);
