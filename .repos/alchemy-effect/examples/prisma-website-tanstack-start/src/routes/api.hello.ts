import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      GET: ({ request }) =>
        Response.json({
          name: new URL(request.url).searchParams.get("name") ?? "visitor",
          greeting: process.env.GREETING ?? "Hello!",
        }),
    },
  },
});
