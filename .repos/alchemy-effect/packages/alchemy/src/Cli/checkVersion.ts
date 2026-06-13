import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import packageJson from "../../package.json" with { type: "json" };

const NPM_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/alchemy/dist-tags";

/**
 * Pick the dist-tag matching the current channel. For pre-release versions
 * like `2.0.0-beta.33`, npm's `latest` tag points at the most recent stable
 * release — not the newest beta — so we match the prerelease identifier
 * (`beta`, `next`, etc.), falling back through `next` → `latest`.
 */
const pickDistTag = (
  current: string,
  distTags: Record<string, string>,
): string | undefined => {
  const pre = current.split("-", 2)[1];
  if (pre) {
    const id = pre.split(".")[0];
    if (id && distTags[id]) return distTags[id];
    if (distTags.next) return distTags.next;
  }
  return distTags.latest;
};

/**
 * Fetch the published `alchemy` version on the dist-tag matching the
 * current channel and log a warning if it's different from the bundled
 * version. Best-effort: any failure (offline, registry hiccup, slow
 * response) is swallowed silently.
 */
export const checkLatestVersion = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.get(NPM_DIST_TAGS_URL);
  const distTags = (yield* response.json) as Record<string, string>;
  if (typeof distTags !== "object" || distTags === null) return;
  const current = packageJson.version;
  const latest = pickDistTag(current, distTags);
  if (typeof latest !== "string" || latest === current) return;
  const installCmd =
    typeof process !== "undefined" && (process as any).versions?.bun
      ? `bun add alchemy@${latest}`
      : `pnpm add alchemy@${latest}`;
  yield* Effect.logWarning(
    `alchemy ${latest} is available (you're on ${current}). ` +
      `Run \`${installCmd}\` to upgrade.`,
  );
}).pipe(
  Effect.timeout(Duration.seconds(5)),
  Effect.catch(() => Effect.void),
);

// Exported for tests.
export const _internal = { pickDistTag };
