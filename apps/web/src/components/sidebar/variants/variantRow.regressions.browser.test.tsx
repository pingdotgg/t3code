import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../../test/render";
import { installSidebarTree } from "../../../lib/sidebarTree";

vi.mock("./RowAnswers", () => ({
  InlineRowAnswers: () => <div data-row-answers>Allow</div>,
  RowAnswersPopover: () => null,
}));

import { WorkerFoldChip, resolveVariantRow } from "./variantRow";

const thread = {
  title: "A thread",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as unknown as EnvironmentThreadShell;

const row = (overrides: Partial<Parameters<typeof resolveVariantRow>[0]>) =>
  resolveVariantRow({
    style: "folder-detailed",
    threadKey: "env:parent",
    thread,
    status: "ready",
    statusWord: null,
    wokePill: null,
    time: "1m",
    isUnread: false,
    isWoke: false,
    isActive: false,
    isSelected: false,
    hasDraftSurface: false,
    nested: false,
    lastNested: false,
    inFolder: true,
    repo: null,
    mark: null,
    title: <span>Title</span>,
    draft: null,
    pin: null,
    where: <span>branch</span>,
    lineExtras: null,
    remote: null,
    terminal: null,
    jumpHint: null,
    workerCount: null,
    workerSummary: null,
    workersOpen: null,
    onToggleWorkers: () => {},
    answersOpen: false,
    onAnswersOpenChange: () => {},
    onOpenThread: () => {},
    statusSlot: (content: ReactNode) => <span data-status-slot>{content}</span>,
    ...overrides,
  }).body;

it("keeps the terminal control on a worker's line", async () => {
  await using screen = await render(
    <div>{row({ nested: true, terminal: <button type="button">Open terminal</button> })}</div>,
  );
  const button = screen.getByRole("button", { name: "Open terminal" }).element();
  expect(button.closest("[data-row-line1]")).not.toBeNull();
});

it("keeps Settle reachable on a Detailed row showing answers", async () => {
  await using screen = await render(
    <div>
      {row({
        thread: { ...thread, hasPendingApprovals: true },
        statusSlot: (content: ReactNode) => (
          <span data-status-slot>
            {content}
            <button type="button" aria-label="Settle thread" />
          </span>
        ),
      })}
    </div>,
  );
  const settle = screen.getByRole("button", { name: "Settle thread" }).element() as HTMLElement;
  expect(settle.getClientRects().length).toBeGreaterThan(0);
  settle.focus();
  expect(document.activeElement).toBe(settle);
});

it("hides the time under Settle while Settle has keyboard focus", async () => {
  await using screen = await render(
    <div className="sidebar-row-look">
      {row({
        statusSlot: (content: ReactNode) => (
          <span data-status-slot>
            <span data-testid="time" data-yields-to-action="" style={{ transition: "none" }}>
              {content}
            </span>
            <button type="button" aria-label="Settle thread" />
          </span>
        ),
      })}
    </div>,
  );
  const time = screen.getByTestId("time").element();
  expect(getComputedStyle(time).opacity).toBe("1");
  (screen.getByRole("button", { name: "Settle thread" }).element() as HTMLElement).focus();
  expect(getComputedStyle(time).opacity).toBe("0");
});

it("closes an expanded fold chip with Left, and keeps focus on it", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <div data-testid="tree">
      <WorkerFoldChip
        threadKey="env:parent"
        open
        summary="2 workers · 1 working"
        total="2 workers"
        onToggle={onToggle}
      />
    </div>,
  );
  const cleanup = installSidebarTree(screen.getByTestId("tree").element() as HTMLElement);
  const chip = screen.getByRole("button", { name: "2 workers · 1 working", exact: true });
  const element = chip.element() as HTMLElement;
  expect(element.getAttribute("aria-expanded")).toBe("true");
  element.focus();
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(onToggle).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(element);
  cleanup();
});

it("returns focus to the worker's parent when a focused worker row goes away", async () => {
  await using screen = await render(
    <div data-testid="tree">
      <div role="button" aria-label="Parent" tabIndex={0} data-sidebar-row="env:parent" />
      <div role="button" aria-label="Between" tabIndex={0} data-sidebar-row="env:between" />
      <div
        role="button"
        aria-label="Worker"
        tabIndex={0}
        data-sidebar-row="env:worker"
        data-sidebar-parent="env:parent"
      />
      <div role="button" aria-label="After" tabIndex={0} data-sidebar-row="env:after" />
    </div>,
  );
  const cleanup = installSidebarTree(screen.getByTestId("tree").element() as HTMLElement);
  const parent = screen.getByRole("button", { name: "Parent" }).element();
  const worker = screen.getByRole("button", { name: "Worker" }).element() as HTMLElement;
  worker.focus();
  worker.remove();
  await vi.waitFor(() => expect(document.activeElement).toBe(parent));
  cleanup();
});

it("counts Slim's workers with a static robot and a name", async () => {
  await using screen = await render(
    <div>
      {row({ style: "folder-slim", workerCount: 2, workerSummary: "2 workers · 1 working" })}
    </div>,
  );
  const count = screen.getByRole("img", { name: "2 workers · 1 working" }).element();
  expect(count.textContent).toBe("2");
  expect(count.querySelector(".lucide-bot")).not.toBeNull();
  expect(count.closest("button")).toBeNull();
  expect(getComputedStyle(count).cursor).not.toBe("pointer");
});

it("keeps a parent's terminal control beside its answers", async () => {
  await using screen = await render(
    <div>
      {row({
        thread: { ...thread, hasPendingApprovals: true },
        terminal: <button type="button">Open terminal</button>,
      })}
    </div>,
  );
  const button = screen.getByRole("button", { name: "Open terminal" }).element();
  expect(button.closest("[data-line2-rest]")).toBeNull();
});

it("shows a jump label on a worker and on a parent showing answers", async () => {
  const hint = <kbd>Ctrl 1</kbd>;
  await using worker = await render(<div>{row({ nested: true, jumpHint: hint })}</div>);
  expect(worker.getByText("Ctrl 1").element().closest("[data-row-line1]")).not.toBeNull();
  await using parent = await render(
    <div>{row({ thread: { ...thread, hasPendingApprovals: true }, jumpHint: hint })}</div>,
  );
  const label = parent.getByText("Ctrl 1").element();
  expect(label.closest("[data-row-line1]")).not.toBeNull();
  expect(label.closest("[data-status-slot]")).toBeNull();
});

it("takes the fold chip into the sidebar's arrow keys", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <div data-testid="tree">
      <div role="button" aria-label="A thread" tabIndex={0} data-sidebar-row="env:parent">
        <WorkerFoldChip
          threadKey="env:parent"
          open={false}
          summary="2 workers · 1 working"
          total="2 workers"
          onToggle={onToggle}
        />
      </div>
    </div>,
  );
  const cleanup = installSidebarTree(screen.getByTestId("tree").element() as HTMLElement);
  const chip = screen
    .getByRole("button", { name: "2 workers · 1 working", exact: true })
    .element() as HTMLElement;
  const parent = chip.parentElement!;
  parent.focus();
  parent.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(chip);
  chip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(onToggle).toHaveBeenCalledOnce();
  chip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(document.activeElement).toBe(parent);
  cleanup();
});
