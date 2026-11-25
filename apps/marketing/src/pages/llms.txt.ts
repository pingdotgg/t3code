import type { APIRoute } from "astro";

import { CDN_ORIGIN, GITHUB_REPOSITORY_URL } from "../lib/site";
import { absoluteUrl, SITE_NAME, SITE_ORIGIN, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# ${SITE_NAME}

> ${SITE_TAGLINE}. tix is free, MIT-licensed, and designed for direct Tailscale connections without a cloud relay. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop, web, and mobile app.

Official website: ${SITE_ORIGIN}. Release CDN: ${CDN_ORIGIN}. Downloads come from ${absoluteUrl("/download")} and ${GITHUB_REPOSITORY_URL}/releases.

## Official links

- [Download tix](${absoluteUrl("/download")}): macOS, Windows, Linux installers and Android APK
- [Release CDN](${CDN_ORIGIN}): cached GitHub Release downloads
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): release builds and changelogs

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
