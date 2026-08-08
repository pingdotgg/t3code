import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewFaviconUrl, RightPanelTabs } from "./RightPanelTabs";

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondPreviewSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};

const previewSessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: new Date().toISOString(),
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: new Date().toISOString(),
  },
};

function desktopOverlay(favicon: string | null) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    controller: "none" as const,
    favicon,
  };
}

function renderTabs(favicon: string | null = null, secondFavicon?: string) {
  return renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={
        secondFavicon === undefined ? [previewSurface] : [previewSurface, secondPreviewSurface]
      }
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={previewSessions}
      desktopByTabId={{
        "tab-1": desktopOverlay(favicon),
        ...(secondFavicon === undefined ? {} : { "tab-2": desktopOverlay(secondFavicon) }),
      }}
      terminalLabelsById={new Map()}
      onActivate={() => {}}
      onCloseSurface={() => {}}
      onCloseOtherSurfaces={() => {}}
      onCloseSurfacesToRight={() => {}}
      onCloseAllSurfaces={() => {}}
      onCopyFilePath={() => {}}
      onAddBrowser={() => {}}
      onAddTerminal={() => {}}
      onAddDiff={() => {}}
      onAddFiles={() => {}}
      onAddAgents={() => {}}
      browserAvailable
      diffAvailable={false}
      filesAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
}

describe("RightPanelTabs preview favicon", () => {
  it("renders the live tab favicon and skips the Google s2 URL", () => {
    const html = renderTabs("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain("s2/favicons");
    expect(html).toContain("object-contain");
  });

  it("does not send a private hostname to the Google s2 service", () => {
    const html = renderTabs();
    expect(html).not.toContain("s2/favicons");
  });

  it("keeps route-specific favicons isolated between live tabs on one origin", () => {
    const html = renderTabs("data:image/png;base64,AAAA", "data:image/png;base64,BBBB");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
  });

  it("tries the Google URL after a captured favicon fails", () => {
    expect(
      resolvePreviewFaviconUrl({
        capturedUrl: "data:image/png;base64,AAAA",
        googleUrl: "https://www.google.com/s2/favicons?domain=example.com",
        failedCapturedUrl: "data:image/png;base64,AAAA",
        failedGoogleUrl: null,
      }),
    ).toContain("s2/favicons");
  });
});
