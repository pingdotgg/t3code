// Async (non-Effect) Worker that drives a Stream binding the way real users
// do — upload / details / list / delete over simple routes. Used by
// Stream.local.test.ts both against the local video-store simulator and
// (piped through `Alchemy.remote()`) against the real Stream service via the
// remote-bindings proxy.
import type * as cf from "@cloudflare/workers-types";

interface Env {
  STREAM: cf.StreamBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/upload") {
        // The local simulator (like Miniflare's stream plugin) accepts a
        // ReadableStream of the video bytes in place of a URL; the published
        // types only declare the URL overload.
        const upload = env.STREAM.upload as unknown as (
          input: ReadableStream | string,
          params?: cf.StreamUrlUploadParams,
        ) => Promise<cf.StreamVideo>;
        const video = await upload(request.body as unknown as ReadableStream, {
          meta: { title: "alchemy-local-test" },
          creator: "alchemy",
        });
        return Response.json(video);
      }
      if (url.pathname === "/details") {
        const video = await env.STREAM.video(
          url.searchParams.get("id")!,
        ).details();
        return Response.json(video);
      }
      if (url.pathname === "/list") {
        const videos = await env.STREAM.videos.list();
        return Response.json(videos);
      }
      if (url.pathname === "/delete") {
        await env.STREAM.video(url.searchParams.get("id")!).delete();
        return Response.json({ deleted: true });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      // Expected binding errors (e.g. "Video not found") come back as a 200
      // JSON envelope so the test can assert on them without tripping the
      // readiness retry; unexpected errors carry the stack for debugging.
      const error = e as {
        code?: number;
        statusCode?: number;
        message?: string;
        stack?: string;
      };
      return Response.json({
        error: true,
        code: error.code,
        statusCode: error.statusCode,
        message: error.message ?? String(e),
      });
    }
  },
};
