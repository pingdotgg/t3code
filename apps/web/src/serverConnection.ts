const DEFAULT_DEV_SERVER_PORT = 3773;
const DEFAULT_DEV_WEB_PORT = 5733;
const DEV_SERVER_PORT_GAP = DEFAULT_DEV_WEB_PORT - DEFAULT_DEV_SERVER_PORT;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

interface BrowserLocationLike {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly origin?: string;
}

interface ResolveServerConnectionInput {
  readonly bridgeWsUrl?: string;
  readonly envWsUrl?: string;
  readonly isDev: boolean;
  readonly location: BrowserLocationLike;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function inferLoopbackDevServerWsUrl(input: ResolveServerConnectionInput): string | null {
  if (!input.isDev) return null;
  if (!LOOPBACK_HOSTS.has(input.location.hostname)) return null;

  const currentPort = Number.parseInt(input.location.port, 10);
  if (!Number.isInteger(currentPort) || currentPort < DEFAULT_DEV_WEB_PORT) {
    return null;
  }

  const inferredServerPort = currentPort - DEV_SERVER_PORT_GAP;
  if (inferredServerPort < DEFAULT_DEV_SERVER_PORT) {
    return null;
  }

  const protocol = input.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${input.location.hostname}:${String(inferredServerPort)}`;
}

export function resolveServerWsUrlFromInput(input: ResolveServerConnectionInput): string {
  const bridgeWsUrl = trimToUndefined(input.bridgeWsUrl);
  if (bridgeWsUrl) {
    return bridgeWsUrl;
  }

  const envWsUrl = trimToUndefined(input.envWsUrl);
  if (envWsUrl) {
    return envWsUrl;
  }

  const inferredDevServerWsUrl = inferLoopbackDevServerWsUrl(input);
  if (inferredDevServerWsUrl) {
    return inferredDevServerWsUrl;
  }

  const protocol = input.location.protocol === "https:" ? "wss:" : "ws:";
  const port = input.location.port.length > 0 ? `:${input.location.port}` : "";
  return `${protocol}//${input.location.hostname}${port}`;
}

export function resolveServerHttpOriginFromInput(input: ResolveServerConnectionInput): string {
  const fallbackOrigin =
    input.location.origin ??
    `${input.location.protocol}//${input.location.hostname}${input.location.port ? `:${input.location.port}` : ""}`;

  try {
    const wsUrl = new URL(resolveServerWsUrlFromInput(input));
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return fallbackOrigin;
  }
}

function getCurrentInput(): ResolveServerConnectionInput | null {
  if (typeof window === "undefined") {
    return null;
  }

  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.() ?? undefined;
  const envWsUrl = (import.meta.env.VITE_WS_URL as string | undefined) ?? undefined;

  return {
    ...(bridgeWsUrl ? { bridgeWsUrl } : {}),
    ...(envWsUrl ? { envWsUrl } : {}),
    isDev: import.meta.env.DEV,
    location: window.location,
  };
}

export function resolveServerWsUrl(): string {
  const input = getCurrentInput();
  return input ? resolveServerWsUrlFromInput(input) : "";
}

export function resolveServerHttpOrigin(): string {
  const input = getCurrentInput();
  return input ? resolveServerHttpOriginFromInput(input) : "";
}
