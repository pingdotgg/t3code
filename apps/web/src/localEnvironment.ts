export function isLocalEnvironmentDisabled(): boolean {
  return (
    typeof window !== "undefined" && window.desktopBridge?.getLocalEnvironmentEnabled() === false
  );
}
