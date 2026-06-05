import { ProjectId, type OrchestrationProject } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { ProjectSetupScriptRunner } from "../Services/ProjectSetupScriptRunner.ts";
import { ProjectSetupScriptRunnerLive } from "./ProjectSetupScriptRunner.ts";

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
  });

const makeTerminalManagerLayer = (input: {
  open: TerminalManagerShape["open"];
  write: TerminalManagerShape["write"];
}) =>
  Layer.succeed(TerminalManager, {
    open: input.open,
    attachStream: () => Effect.die(new Error("unused")),
    write: input.write,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const makeRunner = (input: {
  project: OrchestrationProject;
  open: TerminalManagerShape["open"];
  write: TerminalManagerShape["write"];
  fileSystem?: Layer.Layer<FileSystem.FileSystem>;
}) =>
  Effect.runPromise(
    Effect.service(ProjectSetupScriptRunner).pipe(
      Effect.provide(
        ProjectSetupScriptRunnerLive.pipe(
          Layer.provideMerge(makeProjectionSnapshotQueryLayer(input.project)),
          Layer.provideMerge(makeTerminalManagerLayer({ open: input.open, write: input.write })),
          Layer.provideMerge(input.fileSystem ?? FileSystem.layerNoop({})),
        ),
      ),
    ),
  );

describe("ProjectSetupScriptRunner", () => {
  it("returns no-script when no setup script exists", async () => {
    const open = vi.fn<TerminalManagerShape["open"]>();
    const write = vi.fn<TerminalManagerShape["write"]>();
    const project = makeProject([]);
    const runner = await makeRunner({ project, open, write });

    const result = await Effect.runPromise(
      runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      }),
    );

    expect(result).toEqual({ status: "no-script" });
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("opens the deterministic setup terminal with worktree env and writes the command", async () => {
    const open = vi.fn<TerminalManagerShape["open"]>(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        label: "Setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn<TerminalManagerShape["write"]>(() => Effect.void);
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    const runner = await makeRunner({ project, open, write });

    const result = await Effect.runPromise(
      runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      }),
    );

    expect(result).toEqual({
      status: "started",
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-setup",
      cwd: "/repo/worktrees/a",
    });
    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-setup",
      cwd: "/repo/worktrees/a",
      worktreePath: "/repo/worktrees/a",
      env: {
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
      },
    });
    expect(write).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "bun install\r",
    });
  });

  it("runs explicit shell setup scripts through bash in the PowerShell terminal", async () => {
    const open = vi.fn<TerminalManagerShape["open"]>(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        label: "Setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn<TerminalManagerShape["write"]>(() => Effect.void);
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "./scripts/worktree-setup.sh",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    const runner = await makeRunner({ project, open, write });

    await Effect.runPromise(
      runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      }),
    );

    expect(write).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "bash scripts/worktree-setup.sh\r",
    });
  });

  it("falls back to scripts/worktree-setup.sh when no explicit setup script exists", async () => {
    const open = vi.fn<TerminalManagerShape["open"]>(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-worktree-setup",
        label: "Worktree setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn<TerminalManagerShape["write"]>(() => Effect.void);
    const project = makeProject([]);
    const runner = await makeRunner({
      project,
      open,
      write,
      fileSystem: FileSystem.layerNoop({
        exists: (filePath) =>
          Effect.succeed(filePath === "/repo/worktrees/a/scripts/worktree-setup.sh"),
      }),
    });

    const result = await Effect.runPromise(
      runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      }),
    );

    expect(result).toEqual({
      status: "started",
      scriptId: "worktree-setup",
      scriptName: "Worktree setup",
      terminalId: "setup-worktree-setup",
      cwd: "/repo/worktrees/a",
    });
    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-worktree-setup",
      cwd: "/repo/worktrees/a",
      worktreePath: "/repo/worktrees/a",
      env: {
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
      },
    });
    expect(write).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "setup-worktree-setup",
      data: "bash scripts/worktree-setup.sh\r",
    });
  });
});
