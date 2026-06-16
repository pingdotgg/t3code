import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { DEFAULT_INTERACTION_MODE } from "../types";
import type { SidebarThreadSummary } from "../types";
import { SidebarThreadRow } from "./Sidebar";

// Double-click-to-rename is a desktop affordance; force the non-mobile path so
// the rename input is reachable regardless of the test browser viewport.
vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
}));

const THREAD_ID = ThreadId.make("thread-1");
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const INITIAL_TITLE = "Original title";

const ROW_TESTID = `thread-row-${THREAD_ID}`;
const TITLE_TESTID = `thread-title-${THREAD_ID}`;

// Spies live at module scope so their call history survives the row's
// re-renders; reset between tests.
const spies = {
  handleThreadClick: vi.fn(),
  startThreadRename: vi.fn(),
  navigateToThread: vi.fn(),
  handleMultiSelectContextMenu: vi.fn(async () => {}),
  handleThreadContextMenu: vi.fn(async () => {}),
  clearSelection: vi.fn(),
  commitRename: vi.fn(),
  attemptArchiveThread: vi.fn(async () => {}),
  openPrLink: vi.fn(),
};

function buildThread(title: string): SidebarThreadSummary {
  return {
    id: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: undefined,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

// Mirrors the real parent (`SidebarProjectItem`): holds the rename state, wires
// `startThreadRename`, and commits by clearing the rename state and persisting
// the new title back onto the thread so the row re-renders with it.
function Harness() {
  const [title, setTitle] = useState(INITIAL_TITLE);
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const renamingCommittedRef = useRef(false);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const startThreadRename = useCallback((threadKey: string, nextTitle: string) => {
    spies.startThreadRename(threadKey, nextTitle);
    setRenamingThreadKey(threadKey);
    setRenamingTitle(nextTitle);
    renamingCommittedRef.current = false;
  }, []);

  const commitRename = useCallback(
    async (threadRef: unknown, newTitle: string, originalTitle: string) => {
      spies.commitRename(threadRef, newTitle, originalTitle);
      const trimmed = newTitle.trim();
      if (trimmed.length > 0) {
        setTitle(trimmed);
      }
      setRenamingThreadKey(null);
      renamingInputRef.current = null;
    },
    [],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  return (
    <AppAtomRegistryProvider>
      <ul>
        <SidebarThreadRow
          thread={buildThread(title)}
          projectCwd={null}
          orderedProjectThreadKeys={[]}
          isActive={false}
          jumpLabel={null}
          appSettingsConfirmThreadArchive={false}
          renamingThreadKey={renamingThreadKey}
          renamingTitle={renamingTitle}
          setRenamingTitle={setRenamingTitle}
          startThreadRename={startThreadRename}
          renamingInputRef={renamingInputRef}
          renamingCommittedRef={renamingCommittedRef}
          confirmingArchiveThreadKey={confirmingArchiveThreadKey}
          setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
          confirmArchiveButtonRefs={confirmArchiveButtonRefs}
          handleThreadClick={spies.handleThreadClick}
          navigateToThread={spies.navigateToThread}
          handleMultiSelectContextMenu={spies.handleMultiSelectContextMenu}
          handleThreadContextMenu={spies.handleThreadContextMenu}
          clearSelection={spies.clearSelection}
          commitRename={commitRename}
          cancelRename={cancelRename}
          attemptArchiveThread={spies.attemptArchiveThread}
          openPrLink={spies.openPrLink}
        />
      </ul>
    </AppAtomRegistryProvider>
  );
}

describe("SidebarThreadRow double-click rename", () => {
  beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("double-clicking a row starts the inline rename, focused with text selected", async () => {
    render(<Harness />);

    await expect.element(page.getByTestId(TITLE_TESTID)).toBeVisible();

    await userEvent.dblClick(page.getByTestId(ROW_TESTID));

    const input = page.getByRole("textbox");
    await expect.element(input).toBeVisible();

    const element = input.element() as HTMLInputElement;
    expect(element.value).toBe(INITIAL_TITLE);
    // The existing rename-input ref focuses + selects the whole title.
    expect(document.activeElement).toBe(element);
    expect(element.selectionStart).toBe(0);
    expect(element.selectionEnd).toBe(INITIAL_TITLE.length);
  });

  it("Enter commits the rename and the new title persists on the row", async () => {
    render(<Harness />);

    await userEvent.dblClick(page.getByTestId(ROW_TESTID));
    const input = page.getByRole("textbox");
    await expect.element(input).toBeVisible();

    await userEvent.fill(input, "Renamed thread");
    await userEvent.keyboard("{Enter}");

    // commitRename was invoked with (threadRef, newTitle, originalTitle).
    expect(spies.commitRename).toHaveBeenCalledTimes(1);
    expect(spies.commitRename).toHaveBeenCalledWith(
      expect.anything(),
      "Renamed thread",
      INITIAL_TITLE,
    );

    // Input is gone and the row now shows the persisted title.
    const title = page.getByTestId(TITLE_TESTID);
    await expect.element(title).toBeVisible();
    await expect.element(title).toHaveTextContent("Renamed thread");
  });

  it("Escape cancels the rename without committing", async () => {
    render(<Harness />);

    await userEvent.dblClick(page.getByTestId(ROW_TESTID));
    await expect.element(page.getByRole("textbox")).toBeVisible();

    await userEvent.keyboard("{Escape}");

    expect(spies.commitRename).not.toHaveBeenCalled();
    const title = page.getByTestId(TITLE_TESTID);
    await expect.element(title).toBeVisible();
    await expect.element(title).toHaveTextContent(INITIAL_TITLE);
  });

  it("double-clicking inside the rename input keeps the edit (does not reset to the title)", async () => {
    render(<Harness />);

    await userEvent.dblClick(page.getByTestId(ROW_TESTID));
    const input = page.getByRole("textbox");
    await expect.element(input).toBeVisible();

    await userEvent.fill(input, "Edited but not committed");
    // Double-clicking inside the input (e.g. to select a word) must not bubble
    // to the row and restart the rename, which would wipe the edit.
    await userEvent.dblClick(input);

    expect((input.element() as HTMLInputElement).value).toBe("Edited but not committed");
    expect(spies.commitRename).not.toHaveBeenCalled();
  });

  it("double-clicking the row chrome while already renaming does not restart/reset it", async () => {
    render(<Harness />);

    await userEvent.dblClick(page.getByTestId(ROW_TESTID));
    const input = page.getByRole("textbox");
    await expect.element(input).toBeVisible();
    await userEvent.fill(input, "Edited");
    expect(spies.startThreadRename).toHaveBeenCalledTimes(1);

    // Double-click the row element itself (chrome, not the input).
    const rowEl = page.getByTestId(ROW_TESTID).element();
    rowEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));

    // Guard short-circuits: rename is not restarted and the edit is preserved.
    expect(spies.startThreadRename).toHaveBeenCalledTimes(1);
    expect((input.element() as HTMLInputElement).value).toBe("Edited");
  });

  it("modifier double-click is multi-select intent and does not start a rename", async () => {
    render(<Harness />);

    await userEvent.keyboard("{Shift>}");
    await userEvent.dblClick(page.getByTestId(ROW_TESTID));
    await userEvent.keyboard("{/Shift}");

    await expect.element(page.getByTestId(TITLE_TESTID)).toBeVisible();
    expect(page.getByRole("textbox").elements()).toHaveLength(0);
  });

  it("single click routes through the navigation handler and does not start a rename", async () => {
    render(<Harness />);

    await userEvent.click(page.getByTestId(ROW_TESTID));

    expect(spies.handleThreadClick).toHaveBeenCalledTimes(1);
    // No rename input: the title span is still shown.
    await expect.element(page.getByTestId(TITLE_TESTID)).toBeVisible();
    expect(page.getByRole("textbox").elements()).toHaveLength(0);
  });
});
