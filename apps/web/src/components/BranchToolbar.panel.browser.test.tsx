import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  showContextMenu: vi.fn(),
  writeTextToClipboard: vi.fn(),
}));

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ contextMenu: { show: state.showContextMenu } })) as never,
}));
vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock(import("./BranchToolbarBranchSelector"), async (original) => ({
  ...(await original()),
  BranchToolbarBranchSelector: (() => null) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({
    environmentId: "local",
    projectId: "project",
    worktreePath: state.worktreePath,
  })) as never,
  useProject: (() => ({ workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));

import { BranchToolbar } from "./BranchToolbar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.worktreePath = "/tmp/worktree";
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<ComponentProps<typeof BranchToolbar>>) {
  return act(async () =>
    root.render(
      <BranchToolbar
        layout="panel"
        panelSection="workspace"
        environmentId={EnvironmentId.make("local")}
        threadId={ThreadId.make("thread")}
        showGitControls
        envMode="local"
        envLocked={false}
        startFromOrigin={false}
        onStartFromOriginChange={vi.fn()}
        onEnvModeChange={vi.fn()}
        {...props}
      />,
    ),
  );
}

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  const onEnvironmentChange = vi.fn();
  await render({
    onEnvironmentChange,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toBe("local");
  expect(container.querySelectorAll("button")).toHaveLength(1);

  // A ctrl-click is a macOS secondary click; it must not open the menu.
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();

  await userEvent.click(trigger);
  await expect
    .element(page.getByRole("menuitemradio", { name: "New worktree" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.click(page.getByRole("menuitemradio", { name: "remote" }));
  expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    state.worktreePath = worktreePath;
    await render({ envMode });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(copiedPath !== null);
    if (copiedPath === null) {
      expect(state.showContextMenu).not.toHaveBeenCalled();
      expect(state.writeTextToClipboard).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path"),
      );
    }
  },
);
