// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.1.3
 * (`src/entrypoints/image-passthrough-endpoint.ts`).
 *
 * The production image endpoint for the `passthrough` image service: serves
 * local images through the ASSETS binding and allowed remote images via fetch,
 * without any transformation (workerd cannot run sharp).
 */
import { isRemotePath } from "@astrojs/internal-helpers/path";
import { isRemoteAllowed } from "@astrojs/internal-helpers/remote";
import type { APIRoute } from "astro";
import { fetchWithRedirects } from "astro/assets";
import { imageConfig } from "astro:assets";
import { env } from "cloudflare:workers";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const href = url.searchParams.get("href");
    if (!href) return new Response("Bad Request", { status: 400 });

    const isRemote = isRemotePath(href);

    let response: Response;

    if (isRemote) {
      if (!isRemoteAllowed(href, imageConfig)) {
        return new Response("Forbidden", { status: 403 });
      }
      response = await fetchWithRedirects({
        url: href,
        imageConfig,
      });
    } else {
      const sourceUrl = new URL(href, url.origin);
      if (sourceUrl.origin !== url.origin) {
        return new Response("Forbidden", { status: 403 });
      }
      response = (await (env as unknown as Env).ASSETS.fetch(
        new Request(sourceUrl, { headers: request.headers }),
      )) as unknown as Response;
    }

    if (response.status >= 300 && response.status < 400) {
      return new Response("Not Found", { status: 404 });
    }

    if (!response.ok) {
      return new Response("Not Found", { status: 404 });
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.startsWith("image/")) {
      return new Response("Forbidden", { status: 403 });
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "public, max-age=31536000");
    headers.set("Date", new Date().toUTCString());
    const etag = response.headers.get("ETag");
    if (etag) headers.set("ETag", etag);

    return new Response(response.body, { status: 200, headers });
  } catch {
    return new Response("Internal Server Error", { status: 500 });
  }
};
