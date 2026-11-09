import type { APIRoute } from "astro";

import { ANDROID_PLAY_STORE_URL, GITHUB_REPOSITORY_URL, IOS_APP_STORE_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# T3 Code

> ${SITE_TAGLINE}. T3 Code is free, MIT-licensed, and built by T3 Tools Inc. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, ZCode, and other coding agents from one desktop, web, and mobile app.

The only official websites are https://t3.codes and the web app at https://app.t3.codes. Official builds come from ${absoluteUrl("/download")}, ${GITHUB_REPOSITORY_URL}/releases, the \`t3\` package on npm (\`npx t3@latest\`), the iOS App Store, and Google Play. Any other website that offers a T3 Code download is not affiliated with T3 Tools Inc.

## Official links

- [Download T3 Code](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Web app](https://app.t3.codes): connect to a T3 Code server from a browser
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): release builds and changelogs
- [npm package](https://www.npmjs.com/package/t3): run \`npx t3@latest\`
- [iOS app](${IOS_APP_STORE_URL})
- [Android app](${ANDROID_PLAY_STORE_URL})

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
