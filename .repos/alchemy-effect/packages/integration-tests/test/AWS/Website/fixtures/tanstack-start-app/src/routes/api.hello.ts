import { createFileRoute } from "@tanstack/react-router";

/**
 * Server route exercised through the streaming Function URL origin. Echoes
 * the `echo` query parameter so a cached response is detectable.
 */
export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const echo = new URL(request.url).searchParams.get("echo") ?? "";
        return new Response(`TANSTACK_AWS_API_MARKER:${echo}`, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});
