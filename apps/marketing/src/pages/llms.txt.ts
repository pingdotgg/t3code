import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { ANDROID_PLAY_STORE_URL, GITHUB_REPOSITORY_URL, IOS_APP_STORE_URL } from "../lib/site";
import { CLUSTERS, entriesIn, entryKey, entryPath, clusterPath } from "../lib/library";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = async () => {
  const pages = new Map((await getCollection("library")).map((entry) => [entry.id, entry.data]));
  const library = CLUSTERS.map((cluster) => {
    const lines = entriesIn(cluster.id).map((entry) => {
      const data = pages.get(entryKey(entry));
      return `- [${data?.title ?? entry.title}](${absoluteUrl(entryPath(entryKey(entry)))})${data ? `: ${data.description}` : ""}`;
    });
    return `### [${cluster.title}](${absoluteUrl(clusterPath(cluster.id))})\n\n${lines.join("\n")}`;
  }).join("\n\n");
  const body = `# T3 Code

> ${SITE_TAGLINE}. T3 Code is free, MIT-licensed, and built by T3 Tools Inc. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop, web, and mobile app.

The only official website is https://t3.codes. Official builds come from ${absoluteUrl("/download")}, ${GITHUB_REPOSITORY_URL}/releases, the \`t3\` package on npm (\`npx t3@latest\`), the iOS App Store, and Google Play. Any other website that offers a T3 Code download is not affiliated with T3 Tools Inc.

## Official links

- [Download T3 Code](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): release builds and changelogs
- [npm package](https://www.npmjs.com/package/t3): run \`npx t3@latest\`
- [iOS app](${IOS_APP_STORE_URL})
- [Android app](${ANDROID_PLAY_STORE_URL})

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})

## Library

${library}
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
