import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("preview automation target selection", () => {
  it("refreshes authoritative sessions whenever the caller relies on the active tab", () => {
    const active = snapshot("tab-active");
    expect(
      needsPreviewAutomationSessionSync(
        { snapshot: active, sessions: { [active.tabId]: active } },
        undefined,
        "snapshot",
      ),
    ).toBe(true);
  });

  it("does not sync sessions for environment-scoped cookie writes", () => {
    expect(
      needsPreviewAutomationSessionSync({ snapshot: null, sessions: {} }, undefined, "setCookie"),
    ).toBe(false);
  });

  it("refreshes an explicit tab only when it is absent locally", () => {
    const active = snapshot("tab-active");
    const state = { snapshot: active, sessions: { [active.tabId]: active } };
    expect(needsPreviewAutomationSessionSync(state, active.tabId, "snapshot")).toBe(false);
    expect(needsPreviewAutomationSessionSync(state, "tab-missing", "snapshot")).toBe(true);
  });

  it("does not report the active tab under an unknown requested tab id", () => {
    const active = snapshot("tab-active");
    expect(
      resolvePreviewAutomationTarget(
        { snapshot: active, sessions: { [active.tabId]: active } },
        "tab-missing",
      ),
    ).toEqual({ tabId: null, snapshot: null });
  });

  it("reuses the provider session's pinned tab instead of the mutable UI tab", () => {
    const uiActive = snapshot("tab-ui-active");
    const agentTab = snapshot("tab-opened-by-agent");
    const state = {
      snapshot: uiActive,
      sessions: { [uiActive.tabId]: uiActive, [agentTab.tabId]: agentTab },
    };

    expect(resolvePreviewAutomationOpenTab(state, agentTab.tabId, true)).toBe(agentTab.tabId);
    expect(resolvePreviewAutomationOpenTab(state, undefined, true)).toBe(uiActive.tabId);
    expect(resolvePreviewAutomationOpenTab(state, agentTab.tabId, false)).toBeNull();
  });
});
