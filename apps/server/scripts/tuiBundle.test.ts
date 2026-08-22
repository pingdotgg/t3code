import { describe, expect, it } from "@effect/vitest";

import { findUnresolvedTuiBundleImport } from "./tuiBundle.ts";

describe("findUnresolvedTuiBundleImport", () => {
  it("rejects private workspace imports left in the release bundle", () => {
    expect(findUnresolvedTuiBundleImport('import { x } from "@t3tools/contracts";')).toBe(
      "@t3tools/contracts",
    );
  });

  it("rejects package lookups hidden behind createRequire", () => {
    expect(
      findUnresolvedTuiBundleImport(
        'NodeModule.createRequire(import.meta.url)("@xterm/headless");',
      ),
    ).toBe("@xterm/headless");
  });

  it("rejects createRequire lookups separated by whitespace", () => {
    expect(
      findUnresolvedTuiBundleImport(
        'NodeModule.createRequire(import.meta.url) \n ("@xterm/headless");',
      ),
    ).toBe("@xterm/headless");
  });

  it("rejects bare imports and re-exports of private workspace packages", () => {
    expect(findUnresolvedTuiBundleImport('import "@t3tools/contracts";')).toBe(
      "@t3tools/contracts",
    );
    expect(findUnresolvedTuiBundleImport('export { value } from "@t3tools/shared/model";')).toBe(
      "@t3tools/shared/model",
    );
  });

  it("allows explicit public and native runtime imports", () => {
    expect(
      findUnresolvedTuiBundleImport(
        'import { createCliRenderer } from "@opentui/core";\nimport sharp from "sharp";',
      ),
    ).toBeNull();
  });
});
