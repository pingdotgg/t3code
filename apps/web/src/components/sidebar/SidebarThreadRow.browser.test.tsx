import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SharedTooltipProvider } from "../ui/shared-tooltip";
import { SortableThreadRow } from "./SidebarThreadRow";

describe("SidebarThreadRow settle tooltip placement", () => {
  it.each(["folder", "card"] as const)(
    "opens the Settle tooltip to the right of %s rows instead of above them",
    async (variant) => {
      const environmentId = EnvironmentId.make("local");
      const projectId = ProjectId.make("demo");
      const thread = makeThreadFixture({
        id: ThreadId.make(`settle-placement-${variant}`),
        environmentId,
        projectId,
        title: "Sample thread",
      });

      await using screen = await render(
        <SharedTooltipProvider>
          <ul style={{ width: 120 }}>
            <SortableThreadRow
              thread={thread}
              variant={variant}
              variantAction="settle"
              settlementSupported
              snoozeSupported
              pinningSupported
              isPinned={false}
              sortableId={`${variant}:sample`}
              sortableDisabled
              contextDrag={false}
              dropVerb={null}
              dragOverPinned={false}
              sweepAction={null}
              snoozeWakeLabelText={null}
              wokeAt={null}
              isActive={false}
              isRouteThread={false}
              readOpensPullRequestsInRightPanel={() => false}
              jumpLabel={null}
              environmentLabel="Local"
              environmentMachine="laptop"
              project={{
                id: projectId,
                environmentId,
                title: "demo",
                workspaceRoot: "/work/demo",
                repositoryIdentity: null,
                defaultModelSelection: null,
                createdAt: "2026-03-01T00:00:00.000Z",
                updatedAt: "2026-03-01T00:00:00.000Z",
                scripts: [],
              }}
              projectDisplayName="demo"
              providerEntryByInstanceId={new Map()}
              timestampFormat="12-hour"
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
              onActionSweepStart={vi.fn()}
              onUnsettle={vi.fn()}
              onSnooze={vi.fn()}
              onUnsnooze={vi.fn()}
              onUnpin={vi.fn()}
              onAcknowledgeWoke={vi.fn()}
            />
          </ul>
        </SharedTooltipProvider>,
      );

      const settleButton = screen.getByRole("button", { name: "Settle thread" }).element();
      await act(() => {
        settleButton.dispatchEvent(
          new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
        );
      });

      await vi.waitFor(() => {
        const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
        expect(popup?.textContent).toBe("Settle thread");
        expect(popup?.getAttribute("data-side")).toBe("right");
      });
    },
  );
});
