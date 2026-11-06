import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const TENANT_PROPS = { tenant: "acme" };

/**
 * Fetch `/props` through a loopback stub and return the echoed body. The
 * host is irrelevant: the stub routes straight to the entrypoint.
 */
const fetchProps = (entrypoint: Cloudflare.Fetcher) =>
  entrypoint.fetch(HttpClientRequest.get("http://self/props")).pipe(
    Effect.flatMap((response) => response.text),
    Effect.orDie,
  );

/**
 * Durable Object that mints a stub to its host Worker's default entrypoint
 * with props via `DurableObjectState.exports`.
 */
export class PropsMinter extends Cloudflare.DurableObject<PropsMinter>()(
  "PropsMinter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      return {
        mint: Effect.fn(function* () {
          const entrypoint = yield* state.exports
            .default({ props: TENANT_PROPS })
            .pipe(Effect.orDie);
          return yield* fetchProps(entrypoint);
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `WorkerEntrypoint.test.ts`.
 *
 * `GET /props` echoes `WorkerExecutionContext.props`. `GET /mint` mints a
 * `default` loopback stub with props from the fetch handler and fetches
 * `/props` through it; `GET /mint-do` does the same from a Durable Object.
 * `GET /missing` asks for an entrypoint the Worker does not export.
 */
export default class EntrypointPropsWorker extends Cloudflare.Worker<EntrypointPropsWorker>()(
  "EntrypointPropsWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const minters = yield* PropsMinter;
    const exec = yield* Cloudflare.WorkerExecutionContext;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/props") {
          return HttpServerResponse.text(`props=${JSON.stringify(yield* exec.props)}`);
        }
        if (url.pathname === "/mint") {
          const entrypoint = yield* exec.exports
            .default({ props: TENANT_PROPS })
            .pipe(Effect.orDie);
          return HttpServerResponse.text(`via-worker:${yield* fetchProps(entrypoint)}`);
        }
        if (url.pathname === "/mint-do") {
          return HttpServerResponse.text(`via-do:${yield* minters.getByName("default").mint()}`);
        }
        if (url.pathname === "/missing") {
          return yield* exec.exports.Missing().pipe(
            Effect.map(() => HttpServerResponse.text("minted")),
            Effect.catchTag("EntrypointUnavailableError", (error) =>
              Effect.succeed(HttpServerResponse.text(`${error._tag}:${error.entrypoint}`)),
            ),
          );
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
