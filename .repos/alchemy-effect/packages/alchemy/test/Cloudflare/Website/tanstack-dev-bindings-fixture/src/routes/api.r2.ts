import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.ts";

const readKey = (request: Request) =>
  new URL(request.url).searchParams.get("key");

export const Route = createFileRoute("/api/r2")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = readKey(request);
        if (!key) {
          return Response.json(
            { error: "missing key", marker: env.DEV_MARKER, value: null },
            { status: 400 },
          );
        }

        const object = await env.BUCKET.get(key);
        return Response.json({
          marker: env.DEV_MARKER,
          value: object ? await object.text() : null,
        });
      },
      PUT: async ({ request }) => {
        const key = readKey(request);
        if (!key) {
          return Response.json(
            { error: "missing key", marker: env.DEV_MARKER },
            { status: 400 },
          );
        }

        await env.BUCKET.put(key, await request.text(), {
          httpMetadata: {
            contentType: request.headers.get("content-type") ?? "text/plain",
          },
        });
        return Response.json({ marker: env.DEV_MARKER, ok: true });
      },
    },
  },
});
