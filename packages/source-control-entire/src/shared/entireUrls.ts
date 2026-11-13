export const ENTIRE_WEB_HOST = "entire.com";
export const WEB_HOSTS = new Set([ENTIRE_WEB_HOST, "entire.io"]);

const ENTIRE_SEGMENT = String.raw`(?!(?:-|\.\.)\/)[\w.-]+`;
export const ENTIRE_CHANGE_PATH = new RegExp(
  String.raw`^\/(gh|et)\/(${ENTIRE_SEGMENT})\/(?:-\/trails\/[1-9]\d*\/changes\/(${ENTIRE_SEGMENT})|(${ENTIRE_SEGMENT})(?:\/-\/trails\/[1-9]\d*\/changes|\/trails))\/([1-9]\d*)(?:\/[^/]+)?\/?$`,
  "u",
);

const SEGMENT = /^[A-Za-z0-9_.-]+$/u;
const CLUSTER = /^[A-Za-z0-9.-]+(?::\d+)?$/u;

/** `gh` is a GitHub repository mirrored through Entire; `et` is an Entire-native one. */
export type EntireForge = "gh" | "et";

export interface EntireRepository {
  readonly forge: EntireForge;
  readonly owner: string;
  readonly name: string;
  readonly repository: string;
}

function entireRepository(
  forge: string | undefined,
  owner: string | undefined,
  name: string | undefined,
): EntireRepository | null {
  if ((forge !== "gh" && forge !== "et") || !owner || !name) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || owner === ".." || name === "..") return null;
  return { forge, owner, name, repository: `${forge}/${owner}/${name}` };
}

export function entireRepositoryPath(path: string): EntireRepository | null {
  const [forge, owner, name, ...rest] = path
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "")
    .split("/");
  return rest.length === 0 ? entireRepository(forge, owner, name) : null;
}

export const isEntireCluster = (cluster: string) => CLUSTER.test(cluster);

/**
 * `entire://<cluster>/<gh|et>/<a>/<b>[.git]`. The authority is cut from the literal text, as the
 * Entire CLI does, so `entire://cluster@evil.example/...` is refused rather than read as a host.
 */
export function parseEntireRemote(
  url: string,
): (EntireRepository & { readonly cluster: string; readonly remoteUrl: string }) | null {
  const trimmed = url.trim();
  const match = /^entire:\/\/([^/]*)\/(.+)$/iu.exec(trimmed);
  if (!match?.[1] || !match[2] || !isEntireCluster(match[1])) return null;
  const repository = entireRepositoryPath(match[2]);
  return repository ? { ...repository, cluster: match[1].toLowerCase(), remoteUrl: trimmed } : null;
}

function webPath(url: string): string | null {
  const parsed = URL.parse(url.trim());
  return parsed?.protocol === "https:" && WEB_HOSTS.has(parsed.hostname.toLowerCase())
    ? parsed.pathname
    : null;
}

export function parseEntireTrailUrl(
  url: string,
): (EntireRepository & { readonly number: number }) | null {
  const path = webPath(url);
  const [, forge, owner, projectRepository, name, digits] =
    (path === null ? null : ENTIRE_CHANGE_PATH.exec(path)) ?? [];
  const repository = entireRepository(forge, owner, projectRepository ?? name);
  const number = Number(digits);
  return repository && Number.isSafeInteger(number) ? { ...repository, number } : null;
}

export function isProjectTrailUrl(url: string): boolean {
  const path = webPath(url);
  return path !== null && /^\/(?:gh|et)\/[A-Za-z0-9-]+\/-\/trails\/[1-9]\d*\/?$/u.test(path);
}

export function parseEntireRepositoryUrl(url: string): EntireRepository | null {
  const path = webPath(url);
  if (path === null) return null;
  const [forge, owner, name] = path.split("/").filter((segment) => segment !== "");
  return name === "-" ? null : entireRepository(forge, owner, name?.replace(/\.git$/u, ""));
}
