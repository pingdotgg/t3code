import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  type ThreadContextMenuOptions,
  useProvideThreadContextMenu,
} from "../sidebar/threadContextMenu";
import { TaskBoardPage } from "./TaskBoardPage";

const fixture = vi.hoisted(() => ({
  updateMetadata: vi.fn(async (_request: unknown) => ({ _tag: "Success" as const })),
}));

function shell(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    environmentId: "environment-one",
    projectId: "project-one",
    title,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    updatedAt: "2026-01-01T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    snoozedUntil: null,
    ...overrides,
  };
}

vi.mock("../../state/entities", async (original) => {
  const threads = [
    shell("thread-done", "Finished work"),
    shell("thread-approval", "Needs approval", { hasPendingApprovals: true }),
  ];
  return {
    ...(await original<object>()),
    useVisibleThreadShells: () => threads,
    useProjects: () => [],
  };
});
vi.mock("../../state/session", async (original) => ({
  ...(await original<object>()),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => fixture.updateMetadata,
}));

type MenuCall = [ScopedThreadRef, { x: number; y: number }, ThreadContextMenuOptions | undefined];

function SidebarMenuStub(props: { onMenu: (...args: MenuCall) => void }) {
  useProvideThreadContextMenu(props.onMenu);
  return null;
}

function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

const panel = (label: string) => page.getByRole("region", { name: label }).element();
const column = (label: string) => panel(label).closest<HTMLElement>("[data-board-column]");
const grow = (label: string) => Number(panel(label).parentElement!.style.flexGrow);

describe("TaskBoardPage", () => {
  it("opens the sidebar thread menu on right-click and renames in place", async () => {
    localStorage.clear();
    fixture.updateMetadata.mockClear();
    const onMenu = vi.fn<(...args: MenuCall) => void>();
    await using screen = await render(
      <>
        <SidebarMenuStub onMenu={onMenu} />
        <TaskBoardPage />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Finished work/ }), {
      button: "right",
    });
    expect(onMenu).toHaveBeenCalledOnce();
    const [threadRef, , options] = onMenu.mock.calls[0]!;
    expect(threadRef).toEqual({ environmentId: "environment-one", threadId: "thread-done" });

    options?.onStartRename?.(threadRef, "Finished work");
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await userEvent.fill(input, "Renamed work");
    await userEvent.keyboard("{Enter}");
    expect(fixture.updateMetadata).toHaveBeenCalledWith({
      environmentId: "environment-one",
      input: { threadId: "thread-done", title: "Renamed work" },
    });
  });

  it("collapses, stacks and keeps the layout across remounts", async () => {
    localStorage.clear();
    {
      await using screen = await render(<TaskBoardPage />);
      await userEvent.click(screen.getByRole("button", { name: "Collapse Failed" }));
      await expect.element(screen.getByRole("button", { name: "Expand Failed" })).toBeVisible();

      const header = panel("Working").querySelector("h2")!;
      const from = header.getBoundingClientRect();
      const target = panel("Needs you").getBoundingClientRect();
      const drop = { x: target.left + target.width / 2, y: target.bottom - 10 };
      header.dispatchEvent(pointer("pointerdown", from.left + 10, from.top + 5));
      document.dispatchEvent(pointer("pointermove", from.left + 30, from.top + 5));
      await vi.waitFor(() => expect(panel("Working").className).toContain("opacity-50"));
      document.dispatchEvent(pointer("pointermove", drop.x, drop.y));
      await vi.waitFor(() =>
        expect(panel("Needs you").querySelector(".bg-primary")).not.toBeNull(),
      );
      document.dispatchEvent(pointer("pointerup", drop.x, drop.y));
      await vi.waitFor(() => expect(column("Working")).toBe(column("Needs you")));
    }

    await using screen = await render(<TaskBoardPage />);
    await expect.element(screen.getByRole("button", { name: "Expand Failed" })).toBeVisible();
    const stack = column("Needs you")!;
    expect([...stack.querySelectorAll("section")].map((section) => section.ariaLabel)).toEqual([
      "Needs you",
      "Working",
    ]);
  });

  it("stacks a panel dropped by a single quick move", async () => {
    localStorage.clear();
    await using _screen = await render(<TaskBoardPage />);
    const header = panel("Working").querySelector("h2")!;
    const from = header.getBoundingClientRect();
    const target = panel("Needs you").getBoundingClientRect();
    const drop = { x: target.left + target.width / 2, y: target.bottom - 10 };
    header.dispatchEvent(pointer("pointerdown", from.left + 10, from.top + 5));
    // The only move both activates the drag and lands on the target.
    document.dispatchEvent(pointer("pointermove", drop.x, drop.y));
    await vi.waitFor(() => expect(panel("Working").className).toContain("opacity-50"));
    document.dispatchEvent(pointer("pointerup", drop.x, drop.y));
    await vi.waitFor(() => expect(column("Working")).toBe(column("Needs you")));
  });

  it("resizes stacked panels, keeps the split across remounts, and resets on double-click", async () => {
    localStorage.clear();
    // A layout saved before weights existed loads as equal shares.
    localStorage.setItem(
      "t3code:task-board:layout",
      JSON.stringify({ columns: [["attention", "done"]], collapsed: [] }),
    );
    const separator = { name: "Resize Needs you and Done" };
    {
      await using screen = await render(<TaskBoardPage />);
      const handle = screen.getByRole("separator", separator).element() as HTMLElement;
      expect([grow("Needs you"), grow("Done")]).toEqual([1, 1]);
      // Synthetic drag events have no active browser pointer to capture.
      using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
      const pointer = { bubbles: true, pointerId: 1, button: 0, clientX: 0 };
      handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: 300 }));
      handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientY: 360 }));
      expect(panel("Needs you").className).not.toContain("opacity-50");
      await vi.waitFor(() =>
        expect(localStorage.getItem("t3code:task-board:layout")).toContain("weights"),
      );
      expect(grow("Needs you")).toBeGreaterThan(grow("Done"));
      expect(grow("Needs you") + grow("Done")).toBeCloseTo(2);
    }

    await using screen = await render(<TaskBoardPage />);
    expect(grow("Needs you")).toBeGreaterThan(grow("Done"));
    // Unstyled in tests, the handle has no box for a real pointer to hit.
    const handle = screen.getByRole("separator", separator).element();
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect([grow("Needs you"), grow("Done")]).toEqual([1, 1]));
  });

  it("resizes a column by its edge, keeps the width across remounts, and resets on double-click", async () => {
    localStorage.clear();
    const separator = { name: "Resize Needs you column" };
    const width = () => column("Needs you")!.style.width;
    {
      await using screen = await render(<TaskBoardPage />);
      const handle = screen.getByRole("separator", separator).element() as HTMLElement;
      expect(width()).toBe("288px");
      // Synthetic drag events have no active browser pointer to capture.
      using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
      const pointer = { bubbles: true, pointerId: 1, button: 0, clientY: 0 };
      handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 300 }));
      handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 400 }));
      await vi.waitFor(() =>
        expect(localStorage.getItem("t3code:task-board:layout")).toContain("widths"),
      );
      expect(width()).toBe("388px");
    }

    await using screen = await render(<TaskBoardPage />);
    expect(width()).toBe("388px");
    const handle = screen.getByRole("separator", separator).element();
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect(width()).toBe("288px"));
  });
});
