import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Tripwire for perf issue #9: the diff (`gh pr diff`, up to 8MB) must not load
 * for Summary-only opens. It loads only when the Code tab mounts (inside
 * PullRequestCodeTab); the module chunk alone may preload on Code hover/focus.
 *
 * Why a source tripwire instead of a behavioral render test: the unit project
 * runs in node without jsdom, and PullRequestDetailPanel is a ~2.5k-line panel
 * wired to environment/query/store/router hooks. Mounting it here (even via
 * react-test-renderer, as smaller components do) would need heavy mocks for
 * those hooks that prove less than the check below, so the prior
 * behavioral-test infeasibility still holds.
 *
 * What this proves: the panel never constructs the diff query, so a
 * Summary-only open cannot fetch diff data. Any panel-side fetch must go
 * through `pullRequestEnvironment.diff` (the legacy warmup name is guarded
 * too), so unlike a `loadCodeTab()` call-shape regex this cannot be evaded
 * via `void`/`.then`/wrapper channels.
 * What it does not prove: tab-gating wiring (`mountedTabs`, hover preload).
 * That wiring is intentionally not asserted here — the chunk is KBs and
 * allowed on hover/focus, and only the diff data is the MB-scale regression.
 */
function readDetailPanelSource(): string {
  const filePath = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "PullRequestDetailPanel.tsx",
  );
  return NodeFS.readFileSync(filePath, "utf8");
}

describe("pull request detail lazy diff", () => {
  it("keeps the diff query out of the detail panel", () => {
    const source = readDetailPanelSource();
    expect(source).not.toContain("pullRequestEnvironment.diff");
    expect(source).not.toContain("_diffWarmUpQuery");
  });
});
