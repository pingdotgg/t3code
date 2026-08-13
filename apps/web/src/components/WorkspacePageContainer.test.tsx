import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkspacePageHeader, WorkspacePageHeaderEdgeControl } from "./WorkspacePageContainer";

describe("WorkspacePageHeader", () => {
  it("owns the shared responsive workspace insets", () => {
    const markup = renderToStaticMarkup(<WorkspacePageHeader>Title</WorkspacePageHeader>);

    expect(markup).toContain("pl-[calc(env(safe-area-inset-left)+0.75rem)]");
    expect(markup).toContain("pr-[calc(env(safe-area-inset-right)+0.75rem)]");
    expect(markup).toContain("sm:pl-[calc(env(safe-area-inset-left)+1.25rem)]");
    expect(markup).toContain("sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]");
    expect(markup).toContain(
      "[[data-sidebar-state=collapsed]_&amp;]:pl-[var(--workspace-titlebar-content-left)]",
    );
  });

  it("reserves native controls for Electron unless another surface owns them", () => {
    const reserved = renderToStaticMarkup(
      <WorkspacePageHeader electron>Title</WorkspacePageHeader>,
    );
    const delegated = renderToStaticMarkup(
      <WorkspacePageHeader electron reserveNativeControls={false}>
        Title
      </WorkspacePageHeader>,
    );

    expect(reserved).toContain("drag-region");
    expect(reserved).toContain("wco:pr-[var(--workspace-native-controls-inset)]");
    expect(delegated).toContain("drag-region");
    expect(delegated).not.toContain("wco:pr-[var(--workspace-native-controls-inset)]");
  });

  it("offsets an edge control's hit target without changing the header inset", () => {
    const markup = renderToStaticMarkup(
      <WorkspacePageHeader>
        <WorkspacePageHeaderEdgeControl>
          <button type="button">Refresh</button>
        </WorkspacePageHeaderEdgeControl>
      </WorkspacePageHeader>,
    );

    expect(markup).toContain("-me-[7px]");
    expect(markup).toContain("sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]");
  });
});
