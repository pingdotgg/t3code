export function isLocalEnvironmentDisabled(): boolean {
  return window.desktopBridge?.getLocalEnvironmentEnabled?.() === false;
}
