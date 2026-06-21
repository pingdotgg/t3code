import { getDesktopManagedBearerToken } from "./hostBootstrap";

let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  const hostBearerToken = getDesktopManagedBearerToken();
  if (hostBearerToken) {
    return Promise.resolve(hostBearerToken);
  }
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw error;
  });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
