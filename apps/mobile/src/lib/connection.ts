export interface RemoteConnectionInput {
  readonly serverUrl: string;
  readonly authToken: string;
}

export interface RemoteConnectionConfig {
  readonly serverUrl: string;
  readonly authToken: string | null;
  readonly displayUrl: string;
  readonly httpOrigin: string;
  readonly wsUrl: string;
}

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const REMOTE_HEALTH_PATH = "/api/remote/health";
const PREFLIGHT_TIMEOUT_MS = 5_000;

export function resolveRemoteConnection(input: RemoteConnectionInput): RemoteConnectionConfig {
  const rawServerUrl = input.serverUrl.trim();
  if (rawServerUrl.length === 0) {
    throw new Error("Server URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawServerUrl.includes("://") ? rawServerUrl : `http://${rawServerUrl}`);
  } catch {
    throw new Error("Enter a valid server URL like http://192.168.1.42:3773.");
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Server URL must use http, https, ws, or wss.");
  }

  const httpProtocol =
    parsed.protocol === "https:" || parsed.protocol === "wss:" ? "https:" : "http:";
  const wsProtocol = httpProtocol === "https:" ? "wss:" : "ws:";
  const httpOrigin = `${httpProtocol}//${parsed.host}`;
  const wsUrl = new URL("/ws", `${wsProtocol}//${parsed.host}`);

  const authToken = input.authToken.trim();
  if (authToken.length > 0) {
    wsUrl.searchParams.set("token", authToken);
  }

  return {
    serverUrl: rawServerUrl,
    authToken: authToken.length > 0 ? authToken : null,
    displayUrl: httpOrigin,
    httpOrigin,
    wsUrl: wsUrl.toString(),
  };
}

export async function preflightRemoteConnection(connection: RemoteConnectionConfig): Promise<void> {
  const url = new URL(REMOTE_HEALTH_PATH, connection.httpOrigin);
  if (connection.authToken) {
    url.searchParams.set("token", connection.authToken);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out reaching the T3 server. Check the URL and make sure it is up.", {
        cause: error,
      });
    }
    throw new Error("Could not reach the T3 server. Check the URL and try again.", {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new Error(
      "Remote access rejected the auth token. Verify the server token and try again.",
    );
  }

  if (response.status === 503) {
    throw new Error("The T3 server is up, but it is not ready yet. Wait a moment and try again.");
  }

  if (!response.ok) {
    throw new Error(`Remote server responded with ${response.status}.`);
  }
}
