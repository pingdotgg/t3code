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
  useCopyToClipboard: ((options: { target: string }) => ({
    copyToClipboard: (command: string) => state.writeTextToClipboard(command, options.target),
    isCopied: false,
  })) as never,
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
import { ComposerSurface } from "./chat/ComposerSurface";
import type { ServerUpdateTarget } from "./ServerUpdateAction";

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
      <ComposerSurface.Shell>
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
        />
      </ComposerSurface.Shell>,
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

it("shows a started thread's primary machine as a static label in the composer", async () => {
  await render({
    layout: "composer",
    showGitControls: false,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  expect(container.textContent).toBe("local");
  expect(container.querySelector("button")).toBeNull();
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

it.each([
  { layout: "wide Git", width: 900, showGitControls: true },
  { layout: "narrow Git", width: 360, showGitControls: true },
  { layout: "sole primary non-Git", width: 360, showGitControls: false },
])(
  "copies the pending update from the $layout composer chip",
  async ({ width, showGitControls }) => {
    await page.viewport(1000, 700);
    container.style.width = `${width}px`;
    container.style.setProperty("--chat-content-max-width", `${width}px`);
    const serverUpdate = {
      environmentId: EnvironmentId.make("local"),
      serverLabel: "Build box",
      serverVersion: "0.0.30",
      targetVersion: "0.0.31",
      selfUpdate: null,
      installation: { kind: "npm-global", prefix: "/opt/node" },
    } satisfies ServerUpdateTarget & { serverVersion: string };
    await render({
      layout: "composer",
      envLocked: showGitControls,
      showGitControls,
      availableEnvironments: [
        {
          environmentId: serverUpdate.environmentId,
          projectId: ProjectId.make("project"),
          label: serverUpdate.serverLabel,
          isPrimary: true,
          machine: "server",
        },
      ],
      serverUpdate,
    });

    expect(
      container.querySelector('[data-slot="composer-shell"]')!.getBoundingClientRect().width,
    ).toBe(width);
    const chip = page.getByRole("button", { name: /Build box|Copy update command/ });
    await expect.element(chip).toBeVisible();
    await userEvent.hover(chip);
    await expect.element(page.getByRole("tooltip")).toMatchTextContent("0.0.30");
    await expect.element(page.getByRole("tooltip")).toMatchTextContent("0.0.31");
    await userEvent.click(chip);
    await vi.waitFor(() =>
      expect(state.writeTextToClipboard).toHaveBeenCalledWith(
        "npm install --global --prefix '/opt/node' t3@0.0.31",
        "update command",
      ),
    );
  },
);
