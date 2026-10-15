import type { AssetResource } from "@t3tools/contracts";

import { bitbucketMediaFetchUrl } from "./bitbucketMedia.ts";
import { githubMediaFetchUrl } from "./githubMedia.ts";

export type PullRequestMediaResource = Extract<
  AssetResource,
  { readonly _tag: "github-media" | "bitbucket-media" }
>;

/**
 * The asset resource that loads `source` through the server's source control credential, or
 * null when no host credential decides whether it loads — those keep loading directly.
 */
export function pullRequestMediaResource(
  source: string,
  cwd: string,
): PullRequestMediaResource | null {
  const githubUrl = githubMediaFetchUrl(source);
  if (githubUrl !== null) return { _tag: "github-media", cwd, url: githubUrl };
  const bitbucketUrl = bitbucketMediaFetchUrl(source);
  return bitbucketUrl === null ? null : { _tag: "bitbucket-media", url: bitbucketUrl };
}

/**
 * Last path segment, for the signed URL's display name. A percent sequence a host accepts but
 * `decodeURIComponent` rejects is left encoded rather than failing the whole asset.
 */
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
