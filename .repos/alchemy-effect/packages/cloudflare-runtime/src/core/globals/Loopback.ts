import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Plugin from "../Plugin.ts";
import type * as WorkerdConfig from "../workerd/Config.ts";
import { HEADER_CF_BLOB } from "./CfOptions.shared.ts";
import * as LoopbackServer from "./LoopbackServer.ts";

export class Loopback extends Plugin.Service<
  Loopback,
  {
    readonly route: (
      target: string,
      handler: LoopbackServer.RouteHandler,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/Loopback") {}

export const LoopbackLive = Layer.effect(
  Loopback,
  Effect.gen(function* () {
    const loopbackServer = yield* LoopbackServer.LoopbackServer;

    return Loopback.of({
      services: [
        {
          name: "loopback:server",
          external: {
            address: loopbackServer.address,
            // Serialise `request.cf` into a header so it round-trips to
            // Node-side handlers (as Miniflare does).
            http: { cfBlobHeader: HEADER_CF_BLOB },
          },
        },
        {
          name: "loopback:fetcher",
          worker: {
            compatibilityDate: "2025-01-01",
            modules: [
              {
                name: "loopback/fetcher.worker.js",
                esModule: `
              export default {
                async fetch(request, env, ctx) {
                  const headers = new Headers(request.headers);
                  headers.set("loopback-target", ctx.props.target);
                  headers.set("loopback-secret", env.SECRET);
                  return await env.LOOPBACK.fetch(request, { headers });
                }
              }
            `,
              },
            ],
            bindings: [
              {
                name: "LOOPBACK",
                service: { name: "loopback:server" },
              },
              {
                name: "SECRET",
                text: loopbackServer.secret,
              },
            ],
          },
        },
      ],
      api: {
        route: (target, handler) =>
          loopbackServer.route(target, handler).pipe(
            Effect.map(() => ({
              name: "loopback:fetcher",
              props: { json: JSON.stringify({ target }) },
            })),
          ),
      },
    });
  }),
);
