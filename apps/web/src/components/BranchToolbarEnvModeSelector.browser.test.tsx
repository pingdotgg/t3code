import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY])(
  "blocks new and previous $workspaceNoun actions in an already-open picker without blocking local mode",
  async (terminology) => {
    const onEnvModeChange = vi.fn();
    const onUsePreviousWorktree = vi.fn();
    for (const supported of [true, false]) {
      await act(() =>
        root.render(
          <AppAtomRegistryProvider>
            <BranchToolbarEnvModeSelector
              envLocked={false}
              vcsActionsSupported={supported}
              effectiveEnvMode="worktree"
              activeWorktreePath={null}
              onEnvModeChange={onEnvModeChange}
              previousWorktreeLabel="Previous checkout"
              previousWorktreeBranch="previous"
              onUsePreviousWorktree={onUsePreviousWorktree}
              terminology={terminology}
            />
          </AppAtomRegistryProvider>,
        ),
      );
      if (supported) await userEvent.click(page.getByRole("combobox", { name: "Workspace" }));
    }
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const create = options.find((option) =>
      option.textContent?.includes(`New ${terminology.workspaceNoun}`),
    );
    const previous = options.find((option) => option.textContent?.includes("previous"));
    expect(create?.getAttribute("aria-disabled")).toBe("true");
    expect(previous?.getAttribute("aria-disabled")).toBe("true");
    await act(() => {
      create?.click();
      previous?.click();
    });
    expect(onEnvModeChange).not.toHaveBeenCalled();
    expect(onUsePreviousWorktree).not.toHaveBeenCalled();
    const local = options.find((option) => option !== create && option !== previous)!;
    expect(local.getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(local);
    expect(onEnvModeChange).toHaveBeenCalledExactlyOnceWith("local");
  },
);
