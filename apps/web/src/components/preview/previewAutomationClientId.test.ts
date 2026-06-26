import { describe, expect, it } from "vite-plus/test";

import { createPreviewAutomationClientId } from "./previewAutomationClientId";

describe("createPreviewAutomationClientId", () => {
  it("creates bounded cryptographically random identities for independent host lifetimes", () => {
    const clientIds = Array.from({ length: 32 }, createPreviewAutomationClientId);

    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(clientIds.every((clientId) => clientId.startsWith("preview-"))).toBe(true);
    expect(clientIds.every((clientId) => clientId.length <= 128)).toBe(true);
  });
});
