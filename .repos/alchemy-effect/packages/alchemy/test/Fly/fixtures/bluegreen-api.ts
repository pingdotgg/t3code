import * as Fly from "@/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Site = Fly.App("Site");
export class Api extends Fly.Service<Api>()("Api") {}

export const apiLayer = (version: string) =>
  Api.make(
    {
      app: Site,
      main: import.meta.url,
      env: { VERSION: version },
      deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
      shutdown: { timeout: "30 seconds" },
      services: [
        {
          protocol: "tcp",
          internalPort: 3000,
          autostop: "off",
          ports: [{ port: 80, handlers: ["http"] }],
          checks: [
            {
              type: "http",
              port: 3000,
              path: "/health",
              interval: "2s",
              timeout: "1s",
            },
          ],
        },
      ],
    },
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const shutdown = { received: false };
      if (globalThis.__ALCHEMY_RUNTIME__) {
        yield* Effect.sync(() =>
          process.once("SIGTERM", () => {
            shutdown.received = true;
          }),
        );
      }
      return {
        fetch: Effect.gen(function* () {
          const version = yield* Config.String("VERSION").pipe(Effect.orDie);
          const request = yield* HttpServerRequest;
          if (request.url.startsWith("/health"))
            return HttpServerResponse.text("ok");
          if (request.url.startsWith("/active"))
            return HttpServerResponse.text(String(yield* Ref.get(active)));
          if (request.url.startsWith("/slow")) {
            yield* Ref.update(active, (count) => count + 1);
            yield* Effect.sleep("60 seconds").pipe(
              Effect.ensuring(Ref.update(active, (count) => count - 1)),
            );
            return HttpServerResponse.text(
              `${version}:${shutdown.received ? "drained" : "not-signaled"}`,
            );
          }
          return HttpServerResponse.text(version);
        }),
      };
    }),
  );

export default apiLayer("default");
