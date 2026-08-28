// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptProcess from "./ProjectSetupScriptProcess.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

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

const setupScript = {
  id: "setup",
  name: "Setup",
  command: "bash .cursor/setup-worktree-unix.sh",
  icon: "configure" as const,
  runOnWorktreeCreate: true,
};

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
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
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

const unusedTerminalError = () => Effect.die(new Error("unused"));

const makeTerminalManagerLayer = (
  overrides: Pick<TerminalManager.TerminalManager["Service"], "open" | "write" | "appendOutput">,
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    ...overrides,
    attachStream: unusedTerminalError,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: unusedTerminalError,
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const makeHandle = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<number>;
}): ProjectSetupScriptProcess.ProjectSetupScriptProcessHandle => ({
  stdout: input.stdout === undefined ? Stream.empty : Stream.encodeText(Stream.make(input.stdout)),
  stderr: input.stderr === undefined ? Stream.empty : Stream.encodeText(Stream.make(input.stderr)),
  exitCode: input.exitCode ?? Effect.succeed(input.code ?? 0),
  kill: Effect.void,
});

const testLayer = (input: {
  readonly project: OrchestrationProject;
  readonly terminal: Pick<
    TerminalManager.TerminalManager["Service"],
    "open" | "write" | "appendOutput"
  >;
  readonly process: ProjectSetupScriptProcess.ProjectSetupScriptProcess["Service"];
}) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectSetupScriptProcess.ProjectSetupScriptProcess, input.process),
    ),
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(input.project)),
    Layer.provideMerge(makeTerminalManagerLayer(input.terminal)),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-setup-script-runner-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const openSnapshot = {
  threadId: "thread-1",
  terminalId: "setup-setup",
  cwd: "/repo/worktrees/a",
  worktreePath: "/repo/worktrees/a",
  status: "running" as const,
  pid: 123,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "setup-setup",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ProjectSetupScriptRunner", () => {
  it.effect("returns no-script when no setup script exists", () => {
    const spawn = vi.fn(() => Effect.die("unexpected spawn"));
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const appendOutput = vi.fn(() => Effect.die("unexpected append"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(spawn).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(appendOutput).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        testLayer({
          project,
          terminal: { open, write, appendOutput },
          process: { spawn },
        }),
      ),
    );
  });

  it.effect("runs the setup command as a process and waits for success", () => {
    const spawn = vi.fn((_input: ProjectSetupScriptProcess.ProjectSetupScriptSpawnInput) =>
      Effect.succeed(makeHandle({ stdout: "installed\n", code: 0 })),
    );
    const open = vi.fn(() => Effect.succeed(openSnapshot));
    const write = vi.fn(() => Effect.die("setup must not type into a PTY"));
    const appendOutput = vi.fn(() => Effect.void);
    const project = makeProject([setupScript]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result.status).toBe("succeeded");
      if (result.status !== "succeeded") {
        return;
      }
      expect(result.scriptId).toBe("setup");
      expect(result.scriptName).toBe("Setup");
      expect(result.terminalId).toBe("setup-setup");
      expect(result.cwd).toBe("/repo/worktrees/a");
      expect(result.exitCode).toBe(0);
      expect(result.logPath.length).toBeGreaterThan(0);
      expect(spawn).toHaveBeenCalledWith({
        command: "bash .cursor/setup-worktree-unix.sh",
        cwd: "/repo/worktrees/a",
        env: expect.objectContaining({
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
        }),
      });
      expect(write).not.toHaveBeenCalled();
      expect(appendOutput).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-setup",
        data: "installed\n",
      });
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* fileSystem.readFileString(result.logPath)).toContain("installed");
    }).pipe(
      Effect.provide(
        testLayer({
          project,
          terminal: { open, write, appendOutput },
          process: { spawn },
        }),
      ),
    );
  });

  it.effect("returns failed and logs when the process exits non-zero", () => {
    const spawn = vi.fn(() =>
      Effect.succeed(makeHandle({ stdout: "boom\n", stderr: "nope\n", code: 7 })),
    );
    const open = vi.fn(() => Effect.succeed(openSnapshot));
    const project = makeProject([setupScript]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        return;
      }
      expect(result.exitCode).toBe(7);
      const fileSystem = yield* FileSystem.FileSystem;
      const log = yield* fileSystem.readFileString(result.logPath);
      expect(log).toContain("boom");
      expect(log).toContain("nope");
    }).pipe(
      Effect.provide(
        testLayer({
          project,
          terminal: { open, write: () => Effect.void, appendOutput: () => Effect.void },
          process: { spawn },
        }),
      ),
    );
  });

  it.effect("keeps spawn failures as a structured operation error", () => {
    const spawnCause = new ProjectSetupScriptProcess.ProjectSetupScriptSpawnError({
      command: setupScript.command,
      cwd: "/repo/worktrees/a",
      cause: new Error("ENOENT"),
    });
    const spawn = vi.fn(() => Effect.fail(spawnCause));
    const project = makeProject([setupScript]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("spawn");
        expect(error.threadId).toBe("thread-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(spawnCause);
      }
    }).pipe(
      Effect.provide(
        testLayer({
          project,
          terminal: {
            open: () => Effect.succeed(openSnapshot),
            write: () => Effect.void,
            appendOutput: () => Effect.void,
          },
          process: { spawn },
        }),
      ),
    );
  });

  it.effect("joins an in-flight run for the same worktree instead of spawning twice", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<number>();
      let spawnCount = 0;
      const spawn = vi.fn(() =>
        Effect.gen(function* () {
          spawnCount += 1;
          yield* Deferred.succeed(spawned, undefined);
          const code = yield* Deferred.await(gate);
          return makeHandle({ stdout: "once\n", code });
        }),
      );
      const project = makeProject([setupScript]);

      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const input = {
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        };
        const first = yield* runner.runForThread(input).pipe(Effect.forkChild);
        yield* Deferred.await(spawned);
        const second = yield* runner.runForThread(input).pipe(Effect.forkChild);
        yield* Deferred.succeed(gate, 0);
        const [firstResult, secondResult] = yield* Effect.all([
          Fiber.join(first),
          Fiber.join(second),
        ]);

        expect(spawnCount).toBe(1);
        expect(firstResult.status).toBe("succeeded");
        expect(secondResult.status).toBe("succeeded");
        expect(firstResult).toEqual(secondResult);
      }).pipe(
        Effect.provide(
          testLayer({
            project,
            terminal: {
              open: () => Effect.succeed(openSnapshot),
              write: () => Effect.void,
              appendOutput: () => Effect.void,
            },
            process: { spawn },
          }),
        ),
      );
    }),
  );

  it.effect("still runs the process when the optional terminal viewer fails to open", () => {
    const spawn = vi.fn(() => Effect.succeed(makeHandle({ stdout: "ok\n", code: 0 })));
    const project = makeProject([setupScript]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result.status).toBe("succeeded");
      expect(spawn).toHaveBeenCalledTimes(1);
    }).pipe(
      Effect.provide(
        testLayer({
          project,
          terminal: {
            open: () =>
              Effect.fail(
                new TerminalManager.TerminalCwdStatError({
                  cwd: "/repo/worktrees/a",
                  cause: new Error("stat failed"),
                }),
              ),
            write: () => Effect.die("unexpected write"),
            appendOutput: () => Effect.void,
          },
          process: { spawn },
        }),
      ),
    );
  });
});

describe("ProjectSetupScriptRunner worktree integration", () => {
  it.effect("creates a worktree, runs a marker script, and reports succeeded", () => {
    const liveLayer = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(ProjectSetupScriptProcess.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-setup-script-integration-" }),
      ),
    );

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repoDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-setup-script-repo-",
      });
      const worktreeDir = `${repoDir}-worktree`;
      NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
      NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
      });
      NodeChildProcess.execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
      yield* fileSystem.writeFileString(NodePath.join(repoDir, "README.md"), "hello\n");
      NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: repoDir });
      NodeChildProcess.execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
      NodeChildProcess.execFileSync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], {
        cwd: repoDir,
      });

      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "printf ready > .t3-setup-marker",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      const result = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) =>
          runner.runForThread({
            threadId: "thread-1",
            projectId: "project-1",
            worktreePath: worktreeDir,
          }),
        ),
        Effect.provide(
          liveLayer.pipe(
            Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
            Layer.provideMerge(
              makeTerminalManagerLayer({
                open: () => Effect.succeed({ ...openSnapshot, cwd: worktreeDir }),
                write: () => Effect.die("setup must not type into a PTY"),
                appendOutput: () => Effect.void,
              }),
            ),
          ),
        ),
      );

      expect(result.status).toBe("succeeded");
      if (result.status !== "succeeded") {
        return;
      }
      expect(result.exitCode).toBe(0);
      expect(yield* fileSystem.exists(NodePath.join(worktreeDir, ".t3-setup-marker"))).toBe(true);
      expect(yield* fileSystem.exists(NodePath.join(repoDir, ".t3-setup-marker"))).toBe(false);
      expect(yield* fileSystem.readFileString(NodePath.join(worktreeDir, ".t3-setup-marker"))).toBe(
        "ready",
      );
    }).pipe(Effect.provide(NodeServices.layer));
  });
});
