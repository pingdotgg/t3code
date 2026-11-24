import { TANSTACK_SOURCE_HOST, withoutOwnerMark } from "../shared/definition.ts";

export const TANSTACK_SOURCE_HOSTS = [TANSTACK_SOURCE_HOST] as const;
export type TanStackSourceHost = (typeof TANSTACK_SOURCE_HOSTS)[number];

export function tanStackSourceHost(host: string): TanStackSourceHost | null {
  const normalized = host.trim().toLowerCase();
  return TANSTACK_SOURCE_HOSTS.find((candidate) => candidate === normalized) ?? null;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/** `owner/name` from the API spelling or either web spelling of the owner, `.git` dropped. */
export function tanStackSourceRepositoryPath(path: string): string | null {
  const [owner, name, ...rest] = withoutOwnerMark(
    path
      .trim()
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/u, ""),
  ).split("/");
  return rest.length === 0 &&
    owner !== undefined &&
    name !== undefined &&
    [owner, name].every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
    ? `${owner}/${name}`
    : null;
}

/** Source serves git over HTTPS only, at `https://<host>/@<owner>/<repo>.git`. */
export function parseTanStackSourceRemote(
  url: string,
): { readonly host: TanStackSourceHost; readonly repository: string } | null {
  const parsed = URL.parse(url.trim());
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
  const host = tanStackSourceHost(parsed.hostname);
  if (host === null || !parsed.pathname.startsWith("/@")) return null;
  const repository = tanStackSourceRepositoryPath(parsed.pathname);
  return repository === null ? null : { host, repository };
}

export const webRepositoryUrl = (host: string, repository: string) =>
  `https://${host}/@${repository}`;
