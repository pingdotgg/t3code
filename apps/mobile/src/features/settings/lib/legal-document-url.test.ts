import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl, LEGAL_URL } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it("accepts the fork's privacy document", () => {
    expect(isLegalDocumentUrl(LEGAL_URL)).toBe(true);
    expect(new URL(LEGAL_URL).hostname).not.toMatch(/t3\.codes$/);
  });

  it.each(["https://example.com/legal", "https://t3.codes/legal", "javascript:alert(1)"])(
    "rejects a URL outside the legal-document allowlist: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(false);
    },
  );
});
