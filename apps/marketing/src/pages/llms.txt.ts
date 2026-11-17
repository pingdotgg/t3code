import { APP_FULL_NAME, APP_NAME } from "@t3tools/shared/branding";
import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# ${APP_NAME}

> ${SITE_TAGLINE} ${APP_NAME} (${APP_FULL_NAME}) is free and MIT-licensed. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop and web app.

Official builds come from ${absoluteUrl("/download")} and ${GITHUB_REPOSITORY_URL}/releases.

## Official links

- [Download ${APP_NAME}](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): release builds and changelogs
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
