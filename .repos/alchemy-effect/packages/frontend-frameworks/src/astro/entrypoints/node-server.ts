/**
 * `@alchemy.run/frontend-frameworks/astro/entrypoints/node-server` — the
 * Node container server entrypoint the Node deploy target pins as the
 * adapter's `serverEntrypoint`.
 *
 * Compiled by astro's `ssr` environment build (the `astro/app/entrypoint`
 * virtual modules only resolve there), it builds the production `App` from
 * the serialized manifest and exports a web-standard fetch `handler`. The
 * target's finishing pass wraps this handler in a Node HTTP program that
 * serves `clientDirectory` first, then falls through here.
 */
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";

// astro:env `getSecret` reads process.env on the Node runtime.
setGetEnv((key) => process.env[key]);

const app = createApp();

export const handler = (request: Request) =>
  app.render(request, {
    addCookieHeader: true,
    clientAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined,
  });
