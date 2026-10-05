import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = ({ url }) =>
  Response.json({
    name: url.searchParams.get("name") ?? "visitor",
    greeting: process.env.GREETING ?? "Hello!",
  });
