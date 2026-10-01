import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Uploads } from "./Uploads.ts";
import { Visits } from "./Visits.ts";

const GREETING = "Hello from Alchemy";

const page = (message: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${message}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
             background: #1e1e2e; color: #cdd6f4;
             font: 18px/1.5 ui-sans-serif, system-ui, sans-serif; }
      main { text-align: center; }
      h1 { font-size: 2.75rem; margin: 0 0 .5rem; }
      p { margin: 0; color: #a6adc8; }
    </style>
  </head>
  <body><main><h1>${message}</h1><p>Cloudflare Worker · KV · R2</p></main></body>
</html>`;

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    // Fixed, uncommon port so the demo never silently lands on another
    // process's dev server (1337 is the default and is often taken).
    dev: { port: 3111, strictPort: true },
  },
  Effect.gen(function* () {
    const visits = yield* Cloudflare.KV.ReadWriteNamespace(Visits);
    const uploads = yield* Cloudflare.R2.ReadWriteBucket(Uploads);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://internal");

        if (url.pathname === "/favicon.ico") {
          return HttpServerResponse.empty({ status: 404 });
        }

        if (url.pathname === "/upload") {
          const body = yield* request.text;
          yield* uploads.put("latest.txt", body).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ stored: body.length });
        }

        const previous = yield* visits.get("count").pipe(Effect.orDie);
        const count = Number(previous ?? "0") + 1;
        yield* visits.put("count", String(count)).pipe(Effect.orDie);

        // Browsers get a page, curl gets JSON.
        if (request.headers.accept?.includes("text/html")) {
          return HttpServerResponse.html(page(GREETING));
        }
        return yield* HttpServerResponse.json({
          message: GREETING,
          visits: count,
        });
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
    ]),
  ),
) {}
