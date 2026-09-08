// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export const extractPathname = (
  path = "/",
  includeSearch: boolean,
  includeHash: boolean,
): string => {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const url = new URL(`//${path}`, "relative://");
  return `${url.pathname}${includeSearch ? url.search : ""}${includeHash ? url.hash : ""}`;
};

const URL_REGEX = /^https:\/\/+(?<host>[^/]+)\/?(?<path>.*)/;
const HOST_WITH_PORT_REGEX = /.*:\d+$/;
const PATH_REGEX = /^\//;

export const validateUrl = (
  token: string,
  onlyRelative = false,
  disallowPorts = false,
  includeSearch = false,
  includeHash = false,
): [undefined, string] | [string, undefined] => {
  const host = URL_REGEX.exec(token);
  if (host && host.groups && host.groups.host) {
    if (onlyRelative) {
      return [
        undefined,
        `Only relative URLs are allowed. Skipping absolute URL ${token}.`,
      ];
    }

    if (disallowPorts && host.groups.host.match(HOST_WITH_PORT_REGEX)) {
      return [
        undefined,
        `Specifying ports is not supported. Skipping absolute URL ${token}.`,
      ];
    }

    return [
      `https://${host.groups.host}${extractPathname(host.groups.path, includeSearch, includeHash)}`,
      undefined,
    ];
  } else {
    if (!token.startsWith("/") && onlyRelative) {
      token = `/${token}`;
    }

    const path = PATH_REGEX.exec(token);
    if (path) {
      try {
        return [extractPathname(token, includeSearch, includeHash), undefined];
      } catch {
        return [undefined, `Error parsing URL segment ${token}. Skipping.`];
      }
    }
  }

  return [
    undefined,
    onlyRelative
      ? "URLs should begin with a forward-slash."
      : 'URLs should either be relative (e.g. begin with a forward-slash), or use HTTPS (e.g. begin with "https://").',
  ];
};

export function urlHasHost(token: string): boolean {
  const host = URL_REGEX.exec(token);
  return Boolean(host && host.groups && host.groups.host);
}
