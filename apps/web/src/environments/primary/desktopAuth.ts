import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopBridge } from "@t3tools/contracts";

let desktopBearerTokenPromise: Promise<string> | null = null;
let loadedPrimaryHttpBaseUrl: string | null | undefined;

function readPrimaryHttpBaseUrl(bridge: DesktopBridge): string | null {
  return (
    bridge
      .getLocalEnvironmentBootstraps()
      .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.httpBaseUrl ?? null
  );
}

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  // Desktop opens this page before readiness; a port collision can move the backend afterwards.
  if (loadedPrimaryHttpBaseUrl === undefined) {
    loadedPrimaryHttpBaseUrl = readPrimaryHttpBaseUrl(bridge);
  }
  const loadedUrl = loadedPrimaryHttpBaseUrl;
  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().then(
    (token) => {
      if (readPrimaryHttpBaseUrl(bridge) === loadedUrl) {
        return token;
      }
      // Clients here were built for the old port; reload rather than send the token there.
      window.location.reload();
      return new Promise<never>(() => {});
    },
    (error) => {
      desktopBearerTokenPromise = null;
      throw error;
    },
  );
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
  loadedPrimaryHttpBaseUrl = undefined;
}
