import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../lib/openPullRequestLink", () => ({
  useOpenPrLink: () => vi.fn(() => false),
}));

vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../state/terminalSessions", () => ({
  useThreadRunningTerminalIds: () => [],
}));

vi.mock("./ProjectFavicon", () => ({
  ProjectFavicon: () => <span data-testid="project-favicon" />,
}));

vi.mock("./ThreadStatusIndicators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadStatusIndicators")>()),
  useLinkedThreadPullRequest: () => null,
}));

import { SidebarSectionHeader, SidebarThreadRow } from "./Sidebar";
import { sidebarMarkerId } from "./Sidebar.logic";
import { SidebarArchiveAllButton } from "./SidebarArchiveControls";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("SidebarSectionHeader archive composition", () => {
  it("keeps the sortable header and archive action mounted through shelf and batch transitions", async () => {
    const renderHeader = (expanded: boolean, archivableCount: number, isArchiving: boolean) => (
      <DndContext>
        <SortableContext items={[sidebarMarkerId("settled-header")]}>
          <ul>
            <SidebarSectionHeader
              marker="settled-header"
              label="Settled"
              toggle={{ expanded, onToggle: vi.fn() }}
              trailing={
                <SidebarArchiveAllButton
                  archivableCount={archivableCount}
                  isArchiving={isArchiving}
                  onArchiveAll={vi.fn()}
                />
              }
            />
          </ul>
        </SortableContext>
      </DndContext>
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderHeader(false, 3, false));
    });
    try {
      const header = renderer.root.findByType("li");
      const [toggle, archive] = header.findAllByType("button");
      expect(toggle!.parent).toBe(header);
      expect(toggle!.findAllByType(SidebarArchiveAllButton)).toHaveLength(0);
      expect(archive!.props["aria-label"]).toBe("Archive all 3 settled threads");

      await act(async () => {
        renderer.update(renderHeader(true, 0, true));
      });
      expect(renderer.root.findByType("li")).toBe(header);
      expect(header.findAllByType("button")).toEqual([toggle, archive]);
      expect(archive!.props["aria-label"]).toBe("Archiving settled threads");
      expect(archive!.props.disabled).toBe(true);

      await act(async () => {
        renderer.update(renderHeader(true, 0, false));
      });
      expect(renderer.root.findByType("li")).toBe(header);
      expect(header.findAllByType("button")).toEqual([toggle]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});

function makeSettledPinnedThread(): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-settled-pinned"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Settled pinned thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    pullRequests: [],
    branchPullRequest: null,
    latestTurn: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    archivedAt: null,
    settledOverride: "settled",
    settledAt: "2026-08-27T09:00:00.000Z",
    pinnedAt: "2026-08-27T08:30:00.000Z",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("SidebarThreadRow", () => {
  it("keeps the pin marker before adjacent un-settle and archive controls", () => {
    const markup = renderToStaticMarkup(
      <SidebarThreadRow
        thread={makeSettledPinnedThread()}
        variant="slim"
        dropVerb={null}
        dragOverPinned={false}
        variantAction="unsettle"
        settlementSupported
        snoozeSupported={false}
        pinningSupported
        isPinned
        snoozeWakeLabelText={null}
        wokeAt={null}
        isActive={false}
        openPullRequestsInRightPanel={false}
        jumpLabel={null}
        currentEnvironmentId={localEnvironmentId}
        environmentMachine="server"
        environmentLabel={null}
        project={null}
        projectDisplayName="Project"
        providerEntryByInstanceId={new Map()}
        timestampFormat="locale"
        onThreadClick={vi.fn()}
        onThreadActivate={vi.fn()}
        onStartRename={vi.fn()}
        onRenameTitleChange={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        isRenaming={false}
        renamingTitle=""
        onContextMenu={vi.fn()}
        onSettle={vi.fn()}
        onUnsettle={vi.fn()}
        onArchive={vi.fn()}
        onSnooze={vi.fn()}
        onUnsnooze={vi.fn()}
        onUnpin={vi.fn()}
        onAcknowledgeWoke={vi.fn()}
      />,
    );

    const pinIndex = markup.indexOf('aria-label="Unpin thread"');
    const statusSlotIndex = markup.indexOf("group/sidebar-slim-status-slot");
    const unsettleIndex = markup.indexOf('aria-label="Un-settle thread"');
    const archiveIndex = markup.indexOf('aria-label="Archive thread"');

    expect(markup).toContain('data-testid="sidebar-row-slim"');
    expect(pinIndex).toBeGreaterThan(-1);
    expect(statusSlotIndex).toBeGreaterThan(pinIndex);
    expect(unsettleIndex).toBeGreaterThan(statusSlotIndex);
    expect(archiveIndex).toBeGreaterThan(unsettleIndex);
  });
});
