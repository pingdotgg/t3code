import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { NativeImages } from "./images.ts";
import { type ImageName, INTERCEPT_HOST, NativeObject, NativeReviewer } from "./object.ts";

const imageFor = (value: string | null): ImageName => (value === "tools" ? "tools" : "shell");

const execModeFor = (path: string) => {
  if (path === "/snapshot") return "snapshot";
  if (path === "/stdin") return "stdin";
  return "exec";
};

export const NativeWorker = Cloudflare.Worker(
  "NativeWorker",
  {
    main: import.meta.url,
    env: {
      IMAGE_REVISION: Effect.map(NativeImages, (images) => JSON.stringify(images)),
    },
  },
  Effect.gen(function* () {
    const objects = yield* NativeObject;
    const reviewers = yield* NativeReviewer;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        // The container's intercepted requests reach this default entrypoint.
        if (request.headers.host === INTERCEPT_HOST) {
          return HttpServerResponse.text(`intercepted ${request.headers.host}${url.pathname}`);
        }
        // Probe routes share one long-lived object; `?object=` overrides it.
        const probe = objects.getByName(url.searchParams.get("object") ?? "probe");

        switch (url.pathname) {
          case "/ready":
            return HttpServerResponse.text("ready");
          case "/metadata":
            return yield* HttpServerResponse.json(yield* probe.metadata().pipe(Effect.orDie));
          case "/evict": {
            // abort() fails the call by design.
            const result = yield* probe.evict().pipe(Effect.result);
            return HttpServerResponse.text(String(result));
          }
          case "/revision":
            return HttpServerResponse.text(yield* probe.revision().pipe(Effect.orDie));
          case "/lifecycle/interrupt":
          case "/lifecycle/stream":
          case "/lifecycle/monitor":
          case "/lifecycle/intercept": {
            const mode = url.pathname.slice("/lifecycle/".length) as
              | "interrupt"
              | "stream"
              | "monitor"
              | "intercept";
            return yield* HttpServerResponse.json(
              yield* objects.getByName(`lifecycle-${mode}`).lifecycle(mode).pipe(Effect.orDie),
            );
          }
          case "/probe":
            return yield* HttpServerResponse.json(
              yield* probe
                .probe({
                  seed: url.searchParams.has("seed"),
                  restart: url.searchParams.has("restart"),
                  image: imageFor(url.searchParams.get("image")),
                })
                .pipe(Effect.orDie),
            );
          case "/reviewer/shell":
          case "/reviewer/lint": {
            const image = url.pathname.endsWith("/lint") ? "lint" : "shell";
            return yield* HttpServerResponse.json(
              yield* reviewers.getByName(`reviewer-${image}`).exec(image).pipe(Effect.orDie),
            );
          }
          default: {
            // `/image/<name>` starts that image in an object of its own.
            const image = url.pathname.startsWith("/image/")
              ? imageFor(url.pathname.slice("/image/".length))
              : "shell";
            const result = yield* objects
              .getByName(image === "shell" ? "workspace" : `image-${image}`)
              .exec(execModeFor(url.pathname), image)
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json(result);
          }
        }
      }).pipe(
        // Report failures in the body, so a failing test shows why.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
);

export default NativeWorker;
