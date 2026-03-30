const BOOTSTRAP_HASH_KEY = "t3_bootstrap";
const AUTH_SESSION_POLL_ATTEMPTS = 50;
const AUTH_SESSION_POLL_INTERVAL_MS = 100;

interface AuthSessionResponse {
  readonly authenticated: boolean;
}

function normalizeServerHttpOrigin(rawUrl: string): string {
  const wsUrl = new URL(rawUrl);
  const protocol =
    wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
  return `${protocol}//${wsUrl.host}`;
}

export function resolveServerHttpOrigin(): string {
  if (typeof window === "undefined") return "";

  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;

  if (!wsCandidate) {
    return window.location.origin;
  }

  try {
    return normalizeServerHttpOrigin(wsCandidate);
  } catch {
    return window.location.origin;
  }
}

export function consumeBootstrapTokenFromHash(
  locationLike: Location = window.location,
): string | null {
  const hash = locationLike.hash.startsWith("#") ? locationLike.hash.slice(1) : locationLike.hash;
  const params = new URLSearchParams(hash);
  const token = params.get(BOOTSTRAP_HASH_KEY);
  return token && token.length > 0 ? token : null;
}

export function clearBootstrapTokenFromUrl(locationLike: Location = window.location): void {
  const currentUrl = new URL(locationLike.href);
  currentUrl.hash = "";
  window.history.replaceState(window.history.state, "", currentUrl.toString());
}

async function exchangeBootstrapToken(serverOrigin: string, token: string): Promise<void> {
  const response = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    throw new Error(`Browser pairing failed with status ${response.status}`);
  }
}

async function fetchSession(serverOrigin: string): Promise<boolean> {
  const response = await fetch(`${serverOrigin}/api/auth/session`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Auth session check failed with status ${response.status}`);
  }

  const parsed = (await response.json()) as Partial<AuthSessionResponse>;
  return parsed.authenticated === true;
}

async function waitForAuthenticatedSession(serverOrigin: string): Promise<boolean> {
  for (let attempt = 0; attempt < AUTH_SESSION_POLL_ATTEMPTS; attempt += 1) {
    if (await fetchSession(serverOrigin)) {
      return true;
    }
    if (attempt < AUTH_SESSION_POLL_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, AUTH_SESSION_POLL_INTERVAL_MS));
    }
  }
  return false;
}

export async function ensureBrowserPairing(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (window.nativeApi || window.desktopBridge) return true;

  const serverOrigin = resolveServerHttpOrigin();
  const bootstrapToken = consumeBootstrapTokenFromHash();

  if (bootstrapToken) {
    try {
      await exchangeBootstrapToken(serverOrigin, bootstrapToken);
      clearBootstrapTokenFromUrl();
      return waitForAuthenticatedSession(serverOrigin);
    } catch {
      return false;
    }
  }

  return fetchSession(serverOrigin);
}
