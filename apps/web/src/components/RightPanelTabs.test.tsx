import type { DesktopPreviewFavicon, PreviewSessionSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ADD_SURFACE_EMPTY_STATE_ORDER,
  ADD_SURFACE_MENU_ORDER,
  buildAddSurfaceActions,
  RightPanelTabs,
} from "./RightPanelTabs";

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

function overlay(icon: DesktopPreviewFavicon | null) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    controller: "none" as const,
    favicon: icon,
  };
}

function renderTabs(first: DesktopPreviewFavicon | null, second?: DesktopPreviewFavicon) {
  return renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={second ? [previewSurface, secondSurface] : [previewSurface]}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{
        "tab-1": overlay(first),
        ...(second ? { "tab-2": overlay(second) } : {}),
      }}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddTerminal={() => undefined}
      onAddSourceControl={() => undefined}
      onAddPullRequest={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddAgents={() => undefined}
      liveAgentCount={0}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      sourceControlAvailable={false}
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

function actionProps() {
  return {
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddSourceControl: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddAgents: vi.fn(),
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: false,
    filesAvailable: true,
    sourceControlAvailable: true,
    pullRequestAvailable: true,
    agentsAvailable: true,
    liveAgentCount: 3,
  };
}

describe("RightPanelTabs add-surface actions", () => {
  it("keeps Version Control first and unique in the empty state", () => {
    const actions = buildAddSurfaceActions(actionProps(), ADD_SURFACE_EMPTY_STATE_ORDER);
    const sourceControlActions = actions.filter((action) => action.id === "source-control");

    expect(actions[0]?.id).toBe("source-control");
    expect(sourceControlActions).toHaveLength(1);
    expect(actions.some((action) => action.id === "pull-request")).toBe(true);
  });

  it("keeps Version Control last and unique in the add menu", () => {
    const actions = buildAddSurfaceActions(actionProps(), ADD_SURFACE_MENU_ORDER);
    const sourceControlActions = actions.filter((action) => action.id === "source-control");

    expect(actions.at(-1)?.id).toBe("source-control");
    expect(sourceControlActions).toHaveLength(1);
    expect(actions.some((action) => action.id === "pull-request")).toBe(true);
  });

  it("uses the Version Control callback, availability, and disabled reason", () => {
    const props = actionProps();
    const actions = buildAddSurfaceActions(props);
    const sourceControl = actions.find((action) => action.id === "source-control");
    const unavailableSourceControl = buildAddSurfaceActions({
      ...props,
      sourceControlAvailable: false,
    }).find((action) => action.id === "source-control");

    expect(sourceControl?.available).toBe(true);
    sourceControl?.onClick();
    expect(props.onAddSourceControl).toHaveBeenCalledTimes(1);
    expect(unavailableSourceControl?.available).toBe(false);
    expect(unavailableSourceControl?.disabledReason).toBe(
      "Version Control is only available when a project is open in a Git repository.",
    );
  });

  it("preserves the live agent badge in the merged action model", () => {
    const actions = buildAddSurfaceActions(actionProps());

    expect(actions.find((action) => action.id === "agents")?.badgeCount).toBe(3);
    expect(actions.find((action) => action.id === "source-control")?.badgeCount).toBe(0);
  });
});
