import type {
  EnvironmentId,
  ProgramAttemptSnapshot,
  T3ProjectFileScript,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  programAttempt: vi.fn(),
  useEnvironmentQuery: vi.fn(),
  useThreadProjection: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (...args: ReadonlyArray<unknown>) => testState.useEnvironmentQuery(...args),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    programAttempt: (...args: ReadonlyArray<unknown>) => testState.programAttempt(...args),
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: (...args: ReadonlyArray<unknown>) => testState.useThreadProjection(...args),
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));

import {
  ProgramAttemptSummary,
  ThreadDetailsPanel,
  type ThreadDetailsPanelProps,
  programAttemptAttention,
} from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.programAttempt.mockReset();
    testState.useEnvironmentQuery.mockReset();
    testState.useThreadProjection.mockReset();
    testState.programAttempt.mockReturnValue({});
    testState.useEnvironmentQuery.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    testState.useThreadProjection.mockReturnValue(null);
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      environmentConnection: null,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onReconnectEnvironment: vi.fn(),
      onOpenConnectionSettings: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("renders a read-only Program summary with exact identity and CLI guidance", () => {
    const attempt = {
      attemptId: "attempt:s6",
      programId: "agents-dlr",
      taskId: "agents-dlr.7",
      title: "S6 certification",
      checkout: {
        repositoryRoot: "/repo",
        gitCommonDir: "/repo/.git",
        worktreePath: "/repo/worktrees/a-very-long-prepared-worktree",
        branch: "lavender/dirtyloops-parallel-runner",
        startingCommit: "1234567890abcdef",
      },
      projectId: "project:s6",
      threadId: "thread:s6",
      runId: "run:s6",
      state: "terminal",
      runStatus: "interrupted",
      terminalResult: {
        status: "interrupted",
        output: null,
        failure: {
          class: "transport_error",
          message: "T3 restarted before the Program Attempt completed.",
          code: "t3_restart_interrupted",
          retryable: true,
        },
        completedAt: "2026-08-20T00:00:00.000Z",
      },
      terminalAcknowledged: false,
    } as ProgramAttemptSnapshot;

    const markup = renderToStaticMarkup(
      <ProgramAttemptSummary
        attempt={attempt}
        environmentId={"environment:s6" as EnvironmentId}
        status="interrupted"
      />,
    );

    expect(markup).toContain("Dirtyloops task");
    expect(markup).toContain("agents-dlr.7");
    expect(markup).toContain("/repo/worktrees/a-very-long-prepared-worktree");
    expect(markup).toContain("T3 restarted before the Program Attempt completed.");
    expect(markup).toContain("dirtyloops inspect");
    expect(markup).toContain("dirtyloops run &lt;proposal.json&gt;");
    expect(markup).toContain("dirtyloops stop agents-dlr.7");
    expect(markup).not.toContain("Retry");
    expect(markup).not.toContain("Admission");
  });

  it("derives attention without inventing a retry decision", () => {
    const attempt = { terminalResult: null } as ProgramAttemptSnapshot;

    expect(programAttemptAttention(attempt, "running")).toBe("None");
    expect(programAttemptAttention(attempt, "interrupted")).toContain(
      "Dirtyloops will decide whether this Task retries",
    );
  });
});
