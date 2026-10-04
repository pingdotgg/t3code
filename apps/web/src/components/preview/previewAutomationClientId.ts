export function createPreviewAutomationClientId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `preview-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const registeredClientIds = new Map<string, string>();

/** Publish a mounted host's id so client intents can tell whether the server targeted this window. */
export function registerPreviewAutomationClientId(
  environmentId: string,
  clientId: string,
): () => void {
  registeredClientIds.set(environmentId, clientId);
  return () => {
    if (registeredClientIds.get(environmentId) === clientId) {
      registeredClientIds.delete(environmentId);
    }
  };
}

export function readPreviewAutomationClientId(environmentId: string): string | undefined {
  return registeredClientIds.get(environmentId);
}
