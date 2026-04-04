function normalizeToken(token: string | null | undefined): string | null {
  const normalized = token?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeServerUrl(url: string | null | undefined): string | null {
  const normalized = url?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function buildAuthorizedRemoteUrl(input: {
  readonly url: string;
  readonly token: string | null | undefined;
}): string {
  const authorizedUrl = new URL(input.url);
  const token = normalizeToken(input.token);

  if (token) {
    authorizedUrl.searchParams.set("token", token);
  } else {
    authorizedUrl.searchParams.delete("token");
  }

  return authorizedUrl.toString();
}

export function buildRemoteAppConnectionUrl(input: {
  readonly serverUrl: string;
  readonly authToken: string | null | undefined;
  readonly useExpoDevScheme?: boolean;
}): string {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (!serverUrl) {
    throw new Error("Server URL is required.");
  }

  const scheme = input.useExpoDevScheme ? "exp+t3remote" : "t3remote";
  const deepLink = new URL(`${scheme}://connect`);
  deepLink.searchParams.set("serverUrl", serverUrl);

  const authToken = normalizeToken(input.authToken);
  if (authToken) {
    deepLink.searchParams.set("authToken", authToken);
  }

  return deepLink.toString();
}

export function parseRemoteAppConnectionUrl(input: string): {
  readonly serverUrl: string;
  readonly authToken: string | null;
} | null {
  let deepLink: URL;
  try {
    deepLink = new URL(input);
  } catch {
    return null;
  }

  if (deepLink.protocol !== "t3remote:" && deepLink.protocol !== "exp+t3remote:") {
    return null;
  }
  if (deepLink.hostname !== "connect") {
    return null;
  }

  const serverUrl = normalizeServerUrl(deepLink.searchParams.get("serverUrl"));
  if (!serverUrl) {
    return null;
  }

  return {
    serverUrl,
    authToken: normalizeToken(deepLink.searchParams.get("authToken")),
  };
}
