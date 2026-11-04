import type { APIRoute } from "astro";

import { absoluteUrl } from "../lib/seo";

// Answer engines (ChatGPT search, Claude, Perplexity) cite what their crawlers can fetch.
// Naming them keeps a future blanket rule from silently locking out the official site.
const ANSWER_ENGINE_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "Claude-SearchBot",
  "Claude-User",
  "ClaudeBot",
  "PerplexityBot",
  "Bingbot",
  "Googlebot",
];

export const GET: APIRoute = () => {
  const body = [
    ...ANSWER_ENGINE_AGENTS.flatMap((agent) => [`User-agent: ${agent}`, "Allow: /", ""]),
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${absoluteUrl("/sitemap.xml")}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
