import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { BackendApi, Greeting } from "./Spec.ts";

export default class Service extends Cloudflare.Worker<Service>()(
  "Service",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const helloGroup = HttpApiBuilder.group(BackendApi, "Hello", (handlers) =>
      handlers.handle("hello", () =>
        Effect.succeed(new Greeting({ message: "Hello World" })),
      ),
    );

    return {
      fetch: HttpApiBuilder.layer(BackendApi).pipe(
        Layer.provide(helloGroup),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }),
) {}
