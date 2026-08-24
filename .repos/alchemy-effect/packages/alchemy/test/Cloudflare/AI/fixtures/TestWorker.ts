import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Gateway } from "./Gateway.ts";

export default class TestWorker extends Cloudflare.Worker<TestWorker>()(
  "AiGatewayTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/url")) {
          const url = yield* aiGateway.getUrl().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ url });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.AI.QueryGatewayBinding)),
) {}
