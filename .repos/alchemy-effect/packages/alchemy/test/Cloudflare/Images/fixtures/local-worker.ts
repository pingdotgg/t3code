// Async (non-Effect) Worker that drives an Images binding the way real users
// do — `info(...)` and `input(...).transform(...).output(...)` over the
// request body. Used by Images.local.test.ts both against the local
// Sharp-backed simulator and (piped through `Alchemy.remote()`) against the real
// Images service via the remote-bindings proxy.
import type * as cf from "@cloudflare/workers-types";

interface Env {
  IMAGES: cf.ImagesBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/info") {
        const info = await env.IMAGES.info(
          request.body as unknown as cf.ReadableStream<Uint8Array>,
        );
        return Response.json(info);
      }
      if (url.pathname === "/transform") {
        let transformer = env.IMAGES.input(
          request.body as unknown as cf.ReadableStream<Uint8Array>,
        );
        const width = url.searchParams.get("width");
        if (width !== null) {
          transformer = transformer.transform({ width: Number(width) });
        }
        const format = (url.searchParams.get("format") ??
          "image/png") as Parameters<typeof transformer.output>[0]["format"];
        try {
          const result = await transformer.output({ format });
          return result.response() as unknown as Response;
        } catch (e) {
          const error = e as { code?: number; message?: string };
          return Response.json({
            error: true,
            code: error.code,
            message: error.message,
          });
        }
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      const error = e as { stack?: string };
      return new Response(`fixture error: ${error?.stack ?? String(e)}`, {
        status: 500,
      });
    }
  },
};
