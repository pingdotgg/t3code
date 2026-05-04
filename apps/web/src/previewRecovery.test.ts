import { describe, expect, it } from "vitest";

import { isDynamicImportFetchErrorMessage } from "./previewRecovery";

describe("previewRecovery", () => {
  it("detects transient Vite dynamic import fetch failures", () => {
    expect(
      isDynamicImportFetchErrorMessage(
        "Failed to fetch dynamically imported module: http://127.0.0.1:61439/@fs/src/Button.preview.tsx?import",
      ),
    ).toBe(true);
  });

  it("does not treat arbitrary preview runtime errors as transient import fetch failures", () => {
    expect(isDynamicImportFetchErrorMessage("Cannot read properties of undefined")).toBe(false);
  });
});
