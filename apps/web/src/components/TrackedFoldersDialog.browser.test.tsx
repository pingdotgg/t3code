import type { ProjectTrackedFolder, WorkspaceScannedFolder } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { chooseTrackedFolders, TrackedFoldersDialogHost } from "./TrackedFoldersDialog";

function scanned(count: number): WorkspaceScannedFolder[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/code/app/pkg-${index}`,
    name: `pkg-${index}`,
    isGitRepository: true,
    source: "child",
  }));
}

function choose(count: number) {
  return chooseTrackedFolders({
    submitLabel: "Add project",
    workspaceRoot: "/code/app",
    scan: { homeIsGitRepository: true, codeWorkspaceFile: null, folders: scanned(count) },
  });
}

describe("TrackedFoldersDialog", () => {
  it("starts a large scan unchecked and tracks only the folders the user checks", async () => {
    await using _screen = await render(<TrackedFoldersDialogHost />);
    let chosen: Promise<ProjectTrackedFolder[] | null> | undefined;
    await act(() => {
      chosen = choose(10);
    });

    await expect.element(page.getByText("Found 10 repositories")).toBeInTheDocument();
    await expect.element(page.getByText("0 of 10")).toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "Filter folders" }), "pkg-7");
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.click(page.getByRole("button", { name: "Add project" }));

    await expect(chosen).resolves.toEqual([{ path: "/code/app/pkg-7", name: "pkg-7" }]);
  });

  it("checks every folder of a small scan and resolves null on cancel", async () => {
    await using _screen = await render(<TrackedFoldersDialogHost />);
    let chosen: Promise<ProjectTrackedFolder[] | null> | undefined;
    await act(() => {
      chosen = choose(3);
    });

    await expect.element(page.getByText("3 of 3")).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    await expect(chosen).resolves.toBeNull();
  });
});
