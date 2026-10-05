import type { APIRoute } from "astro";

export const GET: APIRoute = ({ request }) =>
  Response.json({
    name: new URL(request.url).searchParams.get("name") ?? "visitor",
    greeting: process.env.GREETING ?? "Hello!",
  });
