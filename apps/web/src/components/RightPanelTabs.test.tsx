import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePullRequestTabLink,
  shouldOpenDefaultBrowserProfileFromMenuClick,
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
  tabMuteMenuItem,
} from "./RightPanelTabs";

describe("browser profile submenu", () => {
  it("reserves touch clicks for opening the choices while mouse clicks use the default", () => {
    expect(shouldOpenDefaultBrowserProfileFromMenuClick("touch")).toBe(false);
    expect(shouldOpenDefaultBrowserProfileFromMenuClick("mouse")).toBe(true);
    expect(shouldOpenDefaultBrowserProfileFromMenuClick(undefined)).toBe(true);
  });
});

function shortcutEvent(
  key: string,
  overrides: Partial<Parameters<typeof surfaceShortcutActionForKey>[1]> = {},
): Parameters<typeof surfaceShortcutActionForKey>[1] {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ...overrides,
  };
}

describe("surface shortcuts", () => {
  const actions = [
    { shortcut: "B", available: true, label: "Browser" },
    { shortcut: "D", available: false, label: "Diff" },
  ] as const;

  it("matches available surface shortcuts case-insensitively", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b"))).toBe(actions[0]);
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("B"))).toBe(actions[0]);
  });

  it("does not activate unavailable surfaces", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("d"))).toBeNull();
  });

  it("leaves modified, composing, and already-handled key events alone", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b", { metaKey: true }))).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { isComposing: true })),
    ).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { defaultPrevented: true })),
    ).toBeNull();
  });
});

describe("surface shortcut typing contexts", () => {
  const makeTarget = (matches: string | null) => ({
    closest(selectors: string) {
      if (matches === null || !selectors.includes(matches)) return null;
      return {};
    },
  });

  it("treats form fields and every editable region as typing contexts", () => {
    expect(surfaceShortcutTargetsTypingContext(makeTarget("input"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("textarea"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("select"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("[contenteditable]"))).toBe(true);
  });

  it("claims letters when focus sits outside any editable region", () => {
    expect(surfaceShortcutTargetsTypingContext(null)).toBe(false);
    expect(surfaceShortcutTargetsTypingContext(makeTarget(null))).toBe(false);
  });
});

describe("tabMuteMenuItem", () => {
  const overlay = (audioMuted: boolean) =>
    ({ audioMuted, audible: false }) as Parameters<typeof tabMuteMenuItem>[0]["overlay"];

  it("stays disabled until the desktop tab exists", () => {
    expect(tabMuteMenuItem({ overlay: null, canResolveRuntimeTabId: true })).toEqual({
      label: "Mute tab",
      disabled: true,
    });
  });

  it("stays disabled when no runtime tab id can be resolved", () => {
    expect(tabMuteMenuItem({ overlay: overlay(false), canResolveRuntimeTabId: false })).toEqual({
      label: "Mute tab",
      disabled: true,
    });
  });

  it("offers mute and unmute once the tab is addressable", () => {
    expect(tabMuteMenuItem({ overlay: overlay(false), canResolveRuntimeTabId: true })).toEqual({
      label: "Mute tab",
      disabled: false,
    });
    expect(tabMuteMenuItem({ overlay: overlay(true), canResolveRuntimeTabId: true })).toEqual({
      label: "Unmute tab",
      disabled: false,
    });
  });
});

describe("pull request tab snapshots", () => {
  const environmentId = EnvironmentId.make("local");
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/api",
    number: 7,
    url: "https://github.com/acme/api/pull/7",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unknown linked state authoritative and scopes matches to environment and host", () => {
    const threads = [{ environmentId, pullRequests: [link] }];
    expect(resolvePullRequestTabLink(threads, environmentId, "github.com", link)).toBe(link);
    expect(
      resolvePullRequestTabLink(threads, EnvironmentId.make("remote"), "github.com", link),
    ).toBeUndefined();
    expect(
      resolvePullRequestTabLink(threads, environmentId, "github.enterprise.test", link),
    ).toBeUndefined();
  });
  it("uses the newest snapshot when several threads link the same PR", () => {
    const snapshot = {
      state: "merged" as const,
      title: "API",
      headBranch: "api",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-02-01T00:00:00Z",
    };
    const newer = { ...link, snapshot };
    expect(
      resolvePullRequestTabLink(
        [{ environmentId, pullRequests: [link, newer] }],
        environmentId,
        "github.com",
        link,
      ),
    ).toBe(newer);
  });
});
