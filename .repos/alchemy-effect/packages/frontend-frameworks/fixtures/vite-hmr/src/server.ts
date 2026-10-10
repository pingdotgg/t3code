import { SERVER_MARKER } from "./server-marker.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/marker") {
      return new Response(JSON.stringify({ marker: SERVER_MARKER }), {
        headers: { "content-type": "application/json" },
      });
    }
    // Assets route ahead of the Worker in both modes, so only unmatched
    // paths land here.
    return new Response("Not Found", { status: 404 });
  },
};
