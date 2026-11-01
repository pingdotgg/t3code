import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

function mediaFileName(segment: string): string {
  let decoded: string;

  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }

  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");

  return name.length > 0 ? name : "bitbucket-media";
}

export function bitbucketMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const api = host === "api.bitbucket.org";

  if (!api && host !== "bitbucket.org" && host !== "www.bitbucket.org") {
    return null;
  }

  const segments = url.pathname.split("/");

  if (api && (segments[1] !== "2.0" || segments[2] !== "repositories")) {
    return null;
  }

  const [workspace, repository, route, ...path] = api ? segments.slice(3) : segments.slice(1);
  const fileName = path.at(-1);

  if (!workspace || !repository || !fileName || path.some((segment) => segment.length === 0)) {
    return null;
  }

  const file = route === "src" || (!api && route === "raw");
  const download = route === "downloads" && path.length === 1;

  if ((!file || path.length < 2) && !download) {
    return null;
  }

  return {
    // Cloud's web host needs a browser session; the API accepts the saved account's token.
    fetchUrl: `https://api.bitbucket.org/2.0/repositories/${workspace}/${repository}/${file ? "src" : "downloads"}/${path.join("/")}`,
    fileName: mediaFileName(fileName),
  };
}
