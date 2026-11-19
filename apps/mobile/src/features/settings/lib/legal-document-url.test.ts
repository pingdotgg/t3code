import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import { isLegalDocumentUrl, resolveMarketingSiteUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each(["https://example.com/legal", "javascript:alert(1)"])(
    "rejects a URL outside the legal-document allowlist: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(false);
    },
  );
});

describe("resolveMarketingSiteUrl", () => {
  it.each([
    [undefined, false, "https://t3.codes/"],
    ["https://fork.example/site", false, "https://fork.example/site/"],
    // A standalone build never falls back to T3's legal documents.
    [undefined, true, null],
    ["javascript:alert(1)", true, null],
    ["https://fork.example", true, "https://fork.example/"],
  ])("resolves %j (standalone %j) to %j", (override, standalone, expected) => {
    expect(resolveMarketingSiteUrl(override, standalone)?.toString() ?? null).toBe(expected);
  });
});
