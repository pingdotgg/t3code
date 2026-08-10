import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";

export function getDesktopLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null {
  const getBootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap;
  return typeof getBootstrap === "function" ? getBootstrap() : null;
}
