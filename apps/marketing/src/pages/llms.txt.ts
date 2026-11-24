import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL } from "../lib/site";
import { SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# HYR Code

> ${SITE_TAGLINE}. HYR Code is free, MIT-licensed, and built by HYR Media LLC. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop and web app.

HYR Code is an unofficial fork based on the T3 Code source code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. HYR Code builds come only from ${GITHUB_REPOSITORY_URL}/releases. The t3.codes websites, the \`t3\` package on npm, and the T3 Code mobile apps belong to upstream T3 Code.

## Links

- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): HYR Code builds and changelogs
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
