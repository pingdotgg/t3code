import {
  createKnownEnvironmentFromWsUrl,
  getKnownEnvironmentBaseUrl,
  type KnownEnvironment,
} from "@t3tools/client-runtime";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";

function createKnownEnvironmentFromDesktopBootstrap(
  bootstrap: DesktopEnvironmentBootstrap | null | undefined,
): KnownEnvironment | null {
  if (!bootstrap?.wsUrl) {
    return null;
  }

  return createKnownEnvironmentFromWsUrl({
    id: `desktop:${bootstrap.label}`,
    label: bootstrap.label,
    source: "desktop-managed",
    wsUrl: bootstrap.wsUrl,
  });
}

export function getPrimaryKnownEnvironment(): KnownEnvironment | null {
  const desktopEnvironment = createKnownEnvironmentFromDesktopBootstrap(
    window.desktopBridge?.getLocalEnvironmentBootstrap(),
  );
  if (desktopEnvironment) {
    return desktopEnvironment;
  }

  const legacyDesktopWsUrl = window.desktopBridge?.getWsUrl();
  if (typeof legacyDesktopWsUrl === "string" && legacyDesktopWsUrl.length > 0) {
    return createKnownEnvironmentFromWsUrl({
      id: "desktop-legacy",
      label: "Local environment",
      source: "desktop-managed",
      wsUrl: legacyDesktopWsUrl,
    });
  }

  const configuredWsUrl = import.meta.env.VITE_WS_URL;
  if (typeof configuredWsUrl === "string" && configuredWsUrl.length > 0) {
    return createKnownEnvironmentFromWsUrl({
      id: "configured-primary",
      label: "Primary environment",
      source: "configured",
      wsUrl: configuredWsUrl,
    });
  }

  return createKnownEnvironmentFromWsUrl({
    id: "window-origin",
    label: "Primary environment",
    source: "window-origin",
    wsUrl: window.location.origin,
  });
}

export function resolvePrimaryEnvironmentBootstrapUrl(): string {
  const baseUrl = getKnownEnvironmentBaseUrl(getPrimaryKnownEnvironment());
  if (!baseUrl) {
    throw new Error("Unable to resolve a known environment bootstrap URL.");
  }
  return baseUrl;
}
