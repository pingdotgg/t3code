import { EnvironmentId } from "@t3tools/contracts";

export function readDesktopHomeEnvironmentId(): EnvironmentId | null {
  const environmentId = window.desktopBridge?.getHomeEnvironmentId?.() ?? null;
  return environmentId === null ? null : EnvironmentId.make(environmentId);
}

export function isLocalEnvironmentDisabled(): boolean {
  return window.desktopBridge?.getLocalEnvironmentEnabled?.() === false;
}
