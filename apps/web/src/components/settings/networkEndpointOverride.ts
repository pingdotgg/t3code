const ABSOLUTE_URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export interface DesktopNetworkEndpointResolution {
  endpointUrl: string | null;
  customValue: string | null;
  usesCustomEndpoint: boolean;
  error: string | null;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function parseHttpUrl(rawValue: string): URL | null {
  try {
    const url = new URL(rawValue);
    if (!isHttpProtocol(url.protocol)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function formatEndpointUrl(url: URL): string {
  if (url.pathname === "/" && url.search === "" && url.hash === "") {
    return `${url.protocol}//${url.host}`;
  }
  return url.toString();
}

function parseAbsoluteCustomUrl(rawValue: string): URL {
  const parsed = new URL(rawValue);
  if (!isHttpProtocol(parsed.protocol)) {
    throw new Error("Use an http:// or https:// URL.");
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error("Enter a valid hostname or URL.");
  }
  return parsed;
}

function parseHostOverride(rawValue: string): URL {
  const parsed = new URL(`http://${rawValue}`);
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Enter only a hostname (and optional port), or a full URL.");
  }
  return parsed;
}

function applyCustomEndpointOverride(defaultEndpoint: URL | null, customValue: string): string {
  if (ABSOLUTE_URL_SCHEME_RE.test(customValue)) {
    const customUrl = parseAbsoluteCustomUrl(customValue);
    if (!defaultEndpoint) {
      return `${customUrl.protocol}//${customUrl.host}`;
    }
    const next = new URL(defaultEndpoint.toString());
    next.protocol = customUrl.protocol;
    if (customUrl.port === "") {
      next.hostname = customUrl.hostname;
      next.port = "";
    } else {
      next.host = customUrl.host;
    }
    return formatEndpointUrl(next);
  }

  if (!defaultEndpoint) {
    throw new Error("Enter a full URL while network access is loading.");
  }

  const hostOverride = parseHostOverride(customValue);
  const next = new URL(defaultEndpoint.toString());
  if (hostOverride.port === "") {
    next.hostname = hostOverride.hostname;
  } else {
    next.host = hostOverride.host;
  }
  return formatEndpointUrl(next);
}

export function resolveDesktopNetworkEndpointUrl(input: {
  endpointUrl: string | null | undefined;
  customHostnameOrUrl: string;
}): DesktopNetworkEndpointResolution {
  const rawEndpointUrl = input.endpointUrl?.trim() ?? "";
  const defaultEndpoint = rawEndpointUrl === "" ? null : parseHttpUrl(rawEndpointUrl);
  const fallbackEndpointUrl = defaultEndpoint ? rawEndpointUrl : null;
  const customValue = input.customHostnameOrUrl.trim();

  if (customValue === "") {
    return {
      endpointUrl: fallbackEndpointUrl,
      customValue: null,
      usesCustomEndpoint: false,
      error: null,
    };
  }

  try {
    const endpointUrl = applyCustomEndpointOverride(defaultEndpoint, customValue);
    return {
      endpointUrl,
      customValue,
      usesCustomEndpoint: true,
      error: null,
    };
  } catch (error) {
    return {
      endpointUrl: fallbackEndpointUrl,
      customValue,
      usesCustomEndpoint: false,
      error: error instanceof Error ? error.message : "Enter a valid hostname or URL.",
    };
  }
}
