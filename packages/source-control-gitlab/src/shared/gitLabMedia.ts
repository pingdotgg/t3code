import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/** A branch or tag can move, so only a raw file read at a full commit SHA is claimed. */
const RAW_FILE_PATH = /^\/([^/]+(?:\/[^/]+)+?)\/-\/raw\/([0-9a-f]{40}|[0-9a-f]{64})\/(.*[^/])$/u;

export interface GitLabRawFile {
  readonly host: string;
  readonly projectPath: string;
  readonly sha: string;
  readonly path: string;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function gitLabRawFile(url: URL): GitLabRawFile | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const match = RAW_FILE_PATH.exec(url.pathname);
  const projectPath = match?.[1] === undefined ? null : decode(match[1]);
  const path = match?.[3] === undefined ? null : decode(match[3]);
  if (projectPath === null || path === null || match?.[2] === undefined) return null;
  return { host: url.host, projectPath, sha: match[2], path };
}

export function gitLabMediaUrl(url: URL): SourceControlMediaUrl | null {
  const file = gitLabRawFile(url);
  if (file === null) return null;
  const fileName = (file.path.split("/").pop() ?? "").replace(/[\p{Cc}\\/]/gu, "");
  return {
    fetchUrl: `${url.protocol}//${url.host}${url.pathname}`,
    fileName: fileName.length > 0 ? fileName : "gitlab-media",
    immutable: true,
  };
}

export function gitLabRawFileUrl(input: {
  readonly repositoryUrl: string;
  readonly sha: string;
  readonly path: string;
}): string | null {
  const path = input.path.split("/").map(encodeURIComponent).join("/");
  let url: URL;
  try {
    url = new URL(`${input.repositoryUrl}/-/raw/${input.sha}/${path}`);
  } catch {
    return null;
  }
  return gitLabMediaUrl(url) === null ? null : url.toString();
}
