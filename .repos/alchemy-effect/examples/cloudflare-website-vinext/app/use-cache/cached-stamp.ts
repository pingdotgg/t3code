import { cacheLife, cacheTag } from "next/cache";

/**
 * Function-level `"use cache"` — Next.js 16's replacement for
 * experimental PPR shells. vinext implements the directive; full
 * `cacheComponents` / resume is still incomplete upstream.
 */
export async function readCachedStamp() {
  "use cache";
  cacheTag("demo-stamp");
  cacheLife({ revalidate: 30 });
  return new Date().toISOString();
}
