export function createPreviewAutomationClientId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `preview-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
