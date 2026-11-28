import {
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ProjectId,
  type WorktreeLayoutCommand,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

// The popup sits above the dialog's backdrop only with the app's styles.
import "~/index.css";

const environmentId = EnvironmentId.make("environment:layout");
const projectId = ProjectId.make("project:layout");

const state = vi.hoisted(() => ({
  commands: [] as WorktreeLayoutCommand[],
  approved: [] as unknown[],
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: (async (_registry: unknown, command: string, value: { input: unknown }) => {
    if (command === "approve") state.approved.push(value.input);
    return { _tag: "Success", value: { commands: state.commands } };
  }) as never,
}));
vi.mock(
  import("../state/filesystem"),
  () =>
    ({
      filesystemEnvironment: { readLayoutCommands: "read", approveLayoutCommands: "approve" },
    }) as never,
);
vi.mock(
  import("../state/session"),
  () =>
    ({
      readEnvironmentScope: (_: EnvironmentId, scope: string) =>
        scope === AuthFilesystemReadScope || scope === AuthTerminalOperateScope,
    }) as never,
);
vi.mock(
  import("../state/presentation"),
  () => ({ environmentPresentations: { serverConfigsAtom: "server-configs" } }) as never,
);
vi.mock(
  import("../rpc/atomRegistry"),
  () => ({ appAtomRegistry: { get: () => new Map() } }) as never,
);

import { act, render } from "../../test/render";
import { ensureWorktreeLayoutApproved } from "../worktreeLayoutApproval";
import { WorktreeLayoutApprovalDialogHost } from "./WorktreeLayoutApprovalDialogHost";

const ask = (command: string) => {
  state.commands = [{ kind: "create", command, approved: false }];
  return ensureWorktreeLayoutApproved({ environmentId, projectId, projectTitle: "Shop" });
};

describe("worktree layout approval dialog", () => {
  it("does not approve a request that replaced the one on screen when the press began", async () => {
    state.approved = [];
    await using _screen = await render(<WorktreeLayoutApprovalDialogHost />, { router: false });
    let first: ReturnType<typeof ask> | undefined;
    await act(() => {
      first = ask("./scripts/new-workspace.sh");
    });
    await expect.element(page.getByText("./scripts/new-workspace.sh")).toBeVisible();

    await userEvent.hover(page.getByRole("button", { name: "Approve and continue" }));
    await commands.pointerDown();
    let second: ReturnType<typeof ask> | undefined;
    try {
      await act(() => {
        second = ask("./scripts/other.sh");
      });
      await expect.element(page.getByText("./scripts/other.sh")).toBeVisible();
    } finally {
      // A step that fails here must not leave the button down for the tests that follow.
      await commands.pointerUp();
    }
    await expect(first).resolves.toEqual({ status: "cancelled" });

    // The replacement is still waiting for its own answer.
    await expect.element(page.getByText("./scripts/other.sh")).toBeVisible();
    expect(state.approved).toEqual([]);

    await userEvent.click(page.getByRole("button", { name: "Approve and continue" }));
    await expect(second).resolves.toEqual({ status: "proceed" });
    expect(state.approved).toEqual([
      { projectId, approvals: [{ kind: "create", command: "./scripts/other.sh" }] },
    ]);
  });
});
