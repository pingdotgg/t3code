import "../index.css";

import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import BranchToolbar from "./BranchToolbar";

vi.mock("./BranchToolbarBranchSelector", () => ({
  BranchToolbarBranchSelector: () => <div data-testid="branch-selector" />,
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-branch-toolbar");
const PROJECT_ID = ProjectId.makeUnsafe("project-branch-toolbar");

describe("BranchToolbar", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Project",
          cwd: "/repo/project",
          model: "gpt-5",
          expanded: true,
          scripts: [],
        },
      ],
      threads: [],
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a segmented local/worktree toggle for editable draft threads", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-11T10:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const onEnvModeChange = vi.fn<(mode: "local" | "worktree") => void>();
    await render(
      <BranchToolbar threadId={THREAD_ID} envLocked={false} onEnvModeChange={onEnvModeChange} />,
    );

    const localToggle = page.getByRole("button", { name: "Local" });
    const worktreeToggle = page.getByRole("button", { name: "New worktree" });

    await expect.element(localToggle).toHaveAttribute("aria-pressed", "true");
    await expect.element(worktreeToggle).toHaveAttribute("aria-pressed", "false");

    await worktreeToggle.click();

    expect(onEnvModeChange).toHaveBeenCalledTimes(1);
    expect(onEnvModeChange).toHaveBeenCalledWith("worktree");
  });

  it("keeps the selected mode visible when the environment is locked", async () => {
    useStore.setState({
      projects: useStore.getState().projects,
      threads: [
        {
          id: THREAD_ID,
          codexThreadId: null,
          projectId: PROJECT_ID,
          title: "Locked thread",
          model: "gpt-5",
          runtimeMode: "full-access",
          interactionMode: "default",
          session: null,
          createdAt: "2026-03-11T10:00:00.000Z",
          latestTurn: null,
          lastVisitedAt: undefined,
          branch: "main",
          worktreePath: null,
          turnDiffSummaries: [],
          activities: [],
          proposedPlans: [],
          error: null,
          messages: [
            {
              id: MessageId.makeUnsafe("message-1"),
              role: "user",
              text: "hello",
              streaming: false,
              createdAt: "2026-03-11T10:00:00.000Z",
            },
          ],
        },
      ],
      threadsHydrated: false,
    });

    const onEnvModeChange = vi.fn<(mode: "local" | "worktree") => void>();
    await render(
      <BranchToolbar threadId={THREAD_ID} envLocked onEnvModeChange={onEnvModeChange} />,
    );

    const localToggle = page.getByRole("button", { name: "Local" });
    const worktreeToggle = page.getByRole("button", { name: "New worktree" });

    await expect.element(localToggle).toBeDisabled();
    await expect.element(worktreeToggle).toBeDisabled();
    await expect.element(localToggle).toHaveAttribute("aria-pressed", "true");

    expect(onEnvModeChange).not.toHaveBeenCalled();
  });
});
