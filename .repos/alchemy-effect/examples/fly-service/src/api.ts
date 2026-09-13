import * as Fly from "alchemy/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Marker, SECRET_NAME, Site } from "./shared.ts";

/**
 * HTTP Service: Fly injects {@link Marker} as env `{@link SECRET_NAME}`.
 * Read it from `fetch` with `Config.string` — never the plaintext.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    yield* Marker;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        const value = yield* Config.string(SECRET_NAME).pipe(
          Effect.orElseSucceed(() => ""),
        );
        const body = {
          ok: value.length > 0,
          name: SECRET_NAME,
        };
        if (url.pathname === "/health" || url.pathname === "/secret") {
          return yield* HttpServerResponse.json(body);
        }
        return yield* HttpServerResponse.json(body);
      }),
    };
  }),
) {}
