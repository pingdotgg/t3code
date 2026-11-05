// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.

/**
 * Outbound interceptor at the top of the user Worker's `globalOutbound`
 * chain, ported from Miniflare's `workers/core/outbound.worker.ts`:
 *
 * 1. Every outbound `fetch()` drops `CF-Connecting-IP` and carries
 *    `CF-Worker` with the Worker's zone, as on Cloudflare's edge.
 * 2. A fetch with `cf.image` transform options (`fetch(url, { cf: { image } })`)
 *    fetches the origin image and transforms it locally with Sharp,
 *    mirroring "transform via Workers". If Sharp can't transform it, the
 *    origin image is returned as is.
 */
interface Env {
  CF_WORKER_ZONE: string;
  /** Node-side Sharp transform (`globals/CfImage.ts`). */
  CF_IMAGE: Fetcher;
}

const RESIZING_VIA_TOKEN = "image-resizing";

const outboundHeaders = (request: Request, env: Env) => {
  const headers = new Headers(request.headers);
  headers.delete("CF-Connecting-IP");
  headers.set("CF-Worker", env.CF_WORKER_ZONE);
  return headers;
};

const resizeImage = async (request: Request, env: Env, image: Record<string, unknown>) => {
  const headers = outboundHeaders(request, env);
  const via = headers.get("via");
  headers.set("via", via ? `${via}, ${RESIZING_VIA_TOKEN}` : RESIZING_VIA_TOKEN);
  const origin = await fetch(request, { headers });
  if (!origin.ok) {
    return origin;
  }
  const source = await origin.arrayBuffer();
  const form = new FormData();
  form.append("image", new Blob([source]));
  form.append("options", JSON.stringify(image));
  const transformed = await env.CF_IMAGE.fetch("http://localhost/cf-image", {
    method: "POST",
    body: form,
  });
  if (!transformed.ok) {
    const originHeaders = new Headers(origin.headers);
    originHeaders.delete("content-encoding");
    originHeaders.delete("content-length");
    return new Response(source, { status: origin.status, headers: originHeaders });
  }
  return transformed;
};

export default {
  fetch(request: Request, env: Env) {
    const image = (request.cf as { image?: unknown } | undefined)?.image;
    if (typeof image === "object" && image !== null && Object.keys(image).length > 0) {
      return resizeImage(request, env, image as Record<string, unknown>);
    }
    return fetch(request, { headers: outboundHeaders(request, env) });
  },
};
