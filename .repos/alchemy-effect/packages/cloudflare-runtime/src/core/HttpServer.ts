import * as Effect from "effect/Effect";
import { DEFAULT_COMPATIBILITY_DATE } from "./internal/constants.ts";
import * as Plugin from "./Plugin.ts";
import { Runtime } from "./Runtime.ts";

class HttpServer extends Plugin.Service<HttpServer>()(
  "cloudflare-runtime/plugin/HttpServer",
) {}

/**
 * Publish an HTTP dev server under a Worker name for local service bindings.
 * The scoped Worker forwards to a fixed upstream address through workerd's
 * HTTP service, preserving the original request URL, headers, streaming body,
 * and WebSocket upgrades. Its registry entry is removed on shutdown.
 */
export const registerHttpServer = (name: string, url: URL) =>
  Effect.flatMap(Runtime, (runtime) =>
    runtime
      .start({
        name,
        compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
        compatibilityFlags: [],
        cache: false,
        bindings: [
          Plugin.useSync(HttpServer, () => ({
            name: "SERVER",
            service: { name: "http-dev-server" },
          })),
        ],
        modules: [
          {
            name: "http-dev-server.js",
            type: "ESModule",
            content: `export default {
        fetch(request, env) { return env.SERVER.fetch(request); }
      };`,
          },
        ],
      })
      .pipe(
        Effect.provideService(
          HttpServer,
          HttpServer.of({
            services: [
              {
                name: "http-dev-server",
                external: {
                  address: `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`,
                  ...(url.protocol === "https:"
                    ? {
                        https: {
                          options: {
                            forwardedProtoHeader: "X-Forwarded-Proto",
                          },
                        },
                      }
                    : { http: { forwardedProtoHeader: "X-Forwarded-Proto" } }),
                },
              },
            ],
          }),
        ),
      ),
  );
