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
      await vi.waitFor(() =>
        expect(panel("Working").parentElement).toBe(panel("Needs you").parentElement),
      );
    }

    await using screen = await render(<TaskBoardPage />);
    await expect.element(screen.getByRole("button", { name: "Expand Failed" })).toBeVisible();
    const column = panel("Needs you").parentElement!;
    expect([...column.querySelectorAll("section")].map((section) => section.ariaLabel)).toEqual([
      "Needs you",
      "Working",
    ]);
  });
});
