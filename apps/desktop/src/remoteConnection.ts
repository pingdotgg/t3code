import type { DesktopConnectionSettings } from "@t3tools/contracts";

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

const toWebSocketProtocol = (protocol: string): string => {
  if (protocol === "http:") return "ws:";
  if (protocol === "https:") return "wss:";
  return protocol;
};

const toHttpProtocol = (protocol: string): string => {
  if (protocol === "ws:") return "http:";
  if (protocol === "wss:") return "https:";
  return protocol;
};

const sanitizeEnvValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

export class DesktopRemoteConnectionConfigError extends Error {
  readonly _tag = "DesktopRemoteConnectionConfigError" as const;

  constructor(message: string) {
    super(message);
    this.name = "DesktopRemoteConnectionConfigError";
  }
}

export interface DesktopRemoteConnectionConfig {
  readonly mode: "remote";
  readonly wsUrl: string;
  readonly httpOrigin: string;
  readonly disableLocalBackend: true;
}

export function resolveDesktopConnectionSettingsFromEnv(
  env: NodeJS.ProcessEnv,
): DesktopConnectionSettings | null {
  const remoteUrl = sanitizeEnvValue(env.T3CODE_DESKTOP_REMOTE_URL);
  if (!remoteUrl) {
    return null;
  }

  return {
    mode: "remote",
    remoteUrl,
    authToken: sanitizeEnvValue(env.T3CODE_DESKTOP_REMOTE_AUTH_TOKEN) ?? "",
  };
}

export function resolveDesktopRemoteConnection(
  settings: DesktopConnectionSettings | null,
): DesktopRemoteConnectionConfig | null {
  if (settings?.mode !== "remote") {
    return null;
  }

  const remoteUrlValue = sanitizeEnvValue(settings.remoteUrl);
  if (!remoteUrlValue) {
    return null;
  }

  let parsedRemoteUrl: URL;
  try {
    parsedRemoteUrl = new URL(remoteUrlValue);
  } catch {
    throw new DesktopRemoteConnectionConfigError(
      "T3CODE_DESKTOP_REMOTE_URL is invalid. Use a full URL such as https://host:3773 or wss://host:3773.",
    );
  }

  if (!SUPPORTED_PROTOCOLS.has(parsedRemoteUrl.protocol)) {
    throw new DesktopRemoteConnectionConfigError(
      `Unsupported remote URL protocol: ${parsedRemoteUrl.protocol}. Use http(s) or ws(s).`,
    );
  }

  const explicitToken = sanitizeEnvValue(settings.authToken);
  const existingToken = sanitizeEnvValue(parsedRemoteUrl.searchParams.get("token") ?? undefined);
  const token = explicitToken ?? existingToken;

  if (!token) {
    throw new DesktopRemoteConnectionConfigError(
      "Remote mode requires an auth token. Set T3CODE_DESKTOP_REMOTE_AUTH_TOKEN or include ?token=... in T3CODE_DESKTOP_REMOTE_URL.",
    );
  }

  const wsUrl = new URL(parsedRemoteUrl.toString());
  wsUrl.protocol = toWebSocketProtocol(parsedRemoteUrl.protocol);
  wsUrl.hash = "";
  wsUrl.searchParams.set("token", token);

  const httpOriginUrl = new URL(wsUrl.toString());
  httpOriginUrl.protocol = toHttpProtocol(wsUrl.protocol);
  httpOriginUrl.pathname = "/";
  httpOriginUrl.search = "";
  httpOriginUrl.hash = "";

  return {
    mode: "remote",
    wsUrl: wsUrl.toString(),
    httpOrigin: httpOriginUrl.origin,
    disableLocalBackend: true,
  };
}

export function resolveDesktopRemoteConnectionFromEnv(
  env: NodeJS.ProcessEnv,
): DesktopRemoteConnectionConfig | null {
  return resolveDesktopRemoteConnection(resolveDesktopConnectionSettingsFromEnv(env));
}

export function redactTokenInWsUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "[redacted]");
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}
