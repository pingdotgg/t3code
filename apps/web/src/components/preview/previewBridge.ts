export const previewBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);
