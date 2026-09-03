import type { DesktopPreviewFavicon, PreviewSessionSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  RightPanelTabs,
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

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};
const sessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
};

const favicon = (dataUrl: string, pageUrl: string): DesktopPreviewFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});

function overlay(
  icon: DesktopPreviewFavicon | null,
  audio?: { audible?: boolean; audioMuted?: boolean },
) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    audioMuted: audio?.audioMuted ?? false,
    audible: audio?.audible ?? false,
    controller: "none" as const,
    favicon: icon,
  };
}

function renderTabs(
  first: DesktopPreviewFavicon | null,
  second?: DesktopPreviewFavicon,
  audio?: { audible?: boolean; audioMuted?: boolean },
  previewRuntimeTabId: ((tabId: string) => string) | null = (tabId) => `runtime:${tabId}`,
) {
  return renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={second ? [previewSurface, secondSurface] : [previewSurface]}
      environmentId={null}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{
        "tab-1": overlay(first, audio),
        ...(second ? { "tab-2": overlay(second) } : {}),
      }}
      {...(previewRuntimeTabId ? { previewRuntimeTabId } : {})}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddBrowserInProfile={() => undefined}
      onAddTerminal={() => undefined}
      onAddPullRequest={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddAgents={() => undefined}
      liveAgentCount={0}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      agentsAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
}

describe("RightPanelTabs preview favicon", () => {
  it("prefers a live capture and never asks Google about a private hostname", () => {
    const captured = renderTabs(favicon("data:image/png;base64,AAAA", "http://24x.xf.local/"));
    expect(captured).toContain("data:image/png;base64,AAAA");
    expect(captured).not.toContain("s2/favicons");
    expect(renderTabs(null)).not.toContain("s2/favicons");
  });

  it("keeps route-specific captures isolated between live tabs on one origin", () => {
    const html = renderTabs(
      favicon("data:image/png;base64,AAAA", "http://24x.xf.local/"),
      favicon("data:image/png;base64,BBBB", "http://24x.xf.local/admin"),
    );
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
  });

  it("hides a capture while the server session still describes another origin", () => {
    const html = renderTabs(favicon("data:image/png;base64,AAAA", "https://example.com/"));
    expect(html).not.toContain("data:image/png;base64,AAAA");
  });
});

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
  // Selector-aware stub: closest() answers only tokens the combined selector
  // would actually match, mirroring how the browser resolves it.
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
    // The chat composer is a contenteditable that sits empty until a draft
    // exists; launcher letters claimed from it redirected prompts into shells.
    // The :not clause sees past contenteditable="false" islands to an editable
    // host around them, so nested editors stay protected too.
    expect(surfaceShortcutTargetsTypingContext(makeTarget("[contenteditable]"))).toBe(true);
  });

  it("claims letters when focus sits outside any editable region", () => {
    expect(surfaceShortcutTargetsTypingContext(null)).toBe(false);
    expect(surfaceShortcutTargetsTypingContext(makeTarget(null))).toBe(false);
  });
});

describe("RightPanelTabs audio indicator", () => {
  // A muted tab only shows the indicator while it is actually making sound:
  // arming mute on a quiet tab is deliberate and stays invisible until there
  // is something to suppress.
  const cases = [
    { audible: false, audioMuted: false, label: null },
    { audible: false, audioMuted: true, label: null },
    { audible: true, audioMuted: false, label: "Mute Local site" },
    { audible: true, audioMuted: true, label: "Unmute Local site" },
  ] as const;

  it.each(cases)("audible=$audible muted=$audioMuted", ({ audible, audioMuted, label }) => {
    const html = renderTabs(null, undefined, { audible, audioMuted });
    if (label === null) {
      expect(html).not.toContain("Mute Local site");
      expect(html).not.toContain("Unmute Local site");
    } else {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("addresses the desktop by runtime tab id, never the server session id", () => {
    // Session ids are only unique per server process; sending one to the
    // Electron manager raises PreviewTabNotFoundError and silently no-ops.
    const seen: string[] = [];
    renderTabs(null, undefined, { audible: true }, (tabId) => {
      seen.push(tabId);
      return `runtime:${tabId}`;
    });
    expect(seen).toContain("tab-1");
  });

  it("hides the toggle when no runtime tab id can be resolved", () => {
    const html = renderTabs(null, undefined, { audible: true }, null);
    expect(html).not.toContain("Mute Local site");
  });
});

describe("tabMuteMenuItem", () => {
  const overlay = (audioMuted: boolean) =>
    ({ audioMuted, audible: false }) as Parameters<typeof tabMuteMenuItem>[0]["overlay"];

  it("stays disabled until the desktop tab exists", () => {
    // The server session id resolves before the preview manager finishes
    // createTab. Muting in that window fails with an error nobody surfaces.
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
