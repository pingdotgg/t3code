// @effect-diagnostics nodeBuiltinImport:off
// Regression coverage keeps the fork-only grid header on upstream's shared titlebar contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("session grid titlebar", () => {
  it("uses the shared workspace page header", () => {
    const source = NodeFS.readFileSync(new URL("./SessionGridView.tsx", import.meta.url), "utf8");

    expect(source).toContain("<WorkspacePageHeader");
    expect(source).toContain("electron={isElectron}");
    expect(source).not.toMatch(/(?:^|[\s"'])workspace-topbar(?:[\s"']|$)/);
  });
});
