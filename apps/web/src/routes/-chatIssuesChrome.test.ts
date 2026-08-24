// @effect-diagnostics nodeBuiltinImport:off
// The issues page is assembled from shared chrome and control primitives, and every hand-rolled
// stand-in for one fails quietly: an undefined class name is a no-op rather than a layout, and a
// native <select> opens an OS popup with none of the shared focus, hit-target or dark treatment.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const routeSource = NodeFS.readFileSync(new URL("./_chat.issues.tsx", import.meta.url), "utf8");

describe("GitHub issues route chrome", () => {
  it("wears the shared workspace topbar", () => {
    expect(routeSource).toContain("<WorkspacePageHeader");
    // `.workspace-topbar` is not a rule anywhere; only `--workspace-topbar-height` exists.
    expect(routeSource).not.toContain("workspace-topbar");
  });

  it("builds its search and filters from the shared controls", () => {
    expect(routeSource).toContain("<InputGroupInput");
    expect(routeSource).toContain("<SelectTrigger");
    expect(routeSource).not.toMatch(/<select[\s>]/);
  });

  it("renders the one empty state the issue module owns", () => {
    expect(routeSource).toContain("GitHubIssueEmptyState");
    expect(routeSource).not.toContain("function IssueEmptyState");
  });
});
