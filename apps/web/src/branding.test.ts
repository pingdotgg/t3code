import { PRODUCT_BRAND, PRODUCT_LINKS } from "@t3tools/shared/branding";
import { describe, expect, it } from "vite-plus/test";

import { BOOT_DOWNLOAD_URL, BOOT_ISSUE_URL, BOOT_PRODUCT_NAME } from "./lib/bootError";

describe("fork branding", () => {
  // The boot error page cannot import the brand module, so it carries copies.
  it("keeps the boot error page's copies in sync with the brand module", () => {
    expect(BOOT_PRODUCT_NAME).toBe(PRODUCT_BRAND.baseName);
    expect(BOOT_DOWNLOAD_URL).toBe(PRODUCT_LINKS.latestReleaseUrl);
    expect(BOOT_ISSUE_URL).toBe(`${PRODUCT_LINKS.issuesUrl}/new`);
  });
});
