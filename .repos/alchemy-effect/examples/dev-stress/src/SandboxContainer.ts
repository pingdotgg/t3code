import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PORTS } from "./ports.ts";

/**
 * Effect-native Cloudflare Container. Under `alchemy dev` the local
 * provider builds/pulls the image and runs it in Docker; `SandboxDO`
 * fronts it and `EchoWorker` proxies `GET /sandbox` into it.
 *
 * It exists in this stack so the stress suite covers a local resource
 * whose restart is EXPENSIVE: the point of the container assertions is
 * that unrelated churn (worker-source edits, stack reloads, broken
 * intermediate states) must NOT bounce the container.
 */
export class SandboxContainer extends Cloudflare.Container<
  SandboxContainer,
  {}
>()("SandboxContainer") {}

export const SandboxLive = /* @__PURE__ */ SandboxContainer.make(
  {
    main: import.meta.url,
    image: "oven/bun:latest",
    env: {
      SANDBOX_GREETING: "hello-from-container",
      // A LOCALHOST url on purpose: it points at the AWS StaticSite dev
      // server running on the HOST machine. Inside the container,
      // `localhost` is the container itself — the dev runtime must rewrite
      // the host to the `host.docker.localhost` alias for this to resolve —
      // exactly what breaks database URLs from local containers
      // (alchemy-run/alchemy#1334). `GET /host-fetch` proves it.
      HOST_SERVICE_URL: `http://localhost:${PORTS.awsSite}`,
    },
  },
  Effect.gen(function* () {
    return SandboxContainer.of({
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname.endsWith("/host-fetch")) {
          // Reach a service on the DEVELOPER'S machine through an env var
          // that was written as `http://localhost:…` — the database shape
          // of #1334, minus the database.
          const target = process.env.HOST_SERVICE_URL;
          const body = yield* Effect.tryPromise(() =>
            fetch(`${target}/__dev-env`).then((res) => res.text()),
          ).pipe(Effect.orElseSucceed(() => "UNREACHABLE"));
          return yield* HttpServerResponse.json({
            target: target ?? null,
            body,
          });
        }
        return yield* HttpServerResponse.json({
          greeting: process.env.SANDBOX_GREETING ?? null,
          // <<SANDBOX_MARKER>>
          marker: "sandbox-v1",
          // <</SANDBOX_MARKER>>
          path: url.pathname,
        });
      }),
    });
  }),
);

export default SandboxLive;
