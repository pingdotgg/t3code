import type { AssetResource } from "@t3tools/contracts";

import { bitbucketMediaFetchUrl } from "./bitbucketMedia.ts";
import { githubMediaFetchUrl } from "./githubMedia.ts";

export type PullRequestMediaResource = Extract<
  AssetResource,
  { readonly _tag: "github-media" | "bitbucket-media" }
>;

export function pullRequestMediaResource(
  source: string,
  cwd: string,
): PullRequestMediaResource | null {
  const githubUrl = githubMediaFetchUrl(source);
  if (githubUrl !== null) return { _tag: "github-media", cwd, url: githubUrl };
  const bitbucketUrl = bitbucketMediaFetchUrl(source);
  return bitbucketUrl === null ? null : { _tag: "bitbucket-media", url: bitbucketUrl };
}

/** Keep malformed percent escapes from breaking an otherwise usable media URL. */
export function pullRequestMediaFileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "pull-request-media";
}
