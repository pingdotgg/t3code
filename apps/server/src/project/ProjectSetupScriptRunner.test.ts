import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  type OrchestrationProject,
  ProjectId,
  T3ProjectFile,
  type TerminalEvent,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeFileClone } from "../vcs/FileClone.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const encodeProjectFile = Schema.encodeEffect(Schema.fromJsonString(T3ProjectFile));

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

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getUserInputActivity: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getDeletedWorktreeThreads: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShells: () => Effect.die("unused"),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

type TerminalOverrides = Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
  Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe">>;

const makeTerminalManagerLayer = (overrides: TerminalOverrides) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
    ...overrides,
  });

const GitTestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-setup-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const testLayer = (
  project: OrchestrationProject,
  terminal: TerminalOverrides,
  settings = ServerSettings.layerTest(),
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provide(settings),
    Layer.provideMerge(GitTestLayer),
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect(
    "seeds dependencies before setup launch only when an effective setup script exists",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-setup-" });
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        yield* fs.makeDirectory(path.join(source, "node_modules", "pkg"), { recursive: true });
        yield* fs.writeFileString(path.join(source, "node_modules", "pkg", "index.js"), "source");
        yield* fs.writeFileString(path.join(source, ".gitignore"), "node_modules/\n");
        yield* fs.writeFileString(path.join(source, "package.json"), '{"name":"fixture"}');
        yield* fs.writeFileString(path.join(source, "package-lock.json"), '{"lockfileVersion":3}');
        yield* fs.writeFileString(
          path.join(source, "t3.json"),
          yield* encodeProjectFile({
            worktreeCloneDependencies: true,
            scripts: [{ name: "Install", command: "npm ci", runOnWorktreeCreate: true }],
          }),
        );
        for (const args of [
          ["init", "--initial-branch=main"],
          ["config", "user.name", "Test"],
          ["config", "user.email", "test@example.com"],
          ["add", "."],
          ["commit", "-m", "fixture"],
        ])
          yield* driver.execute({ operation: "test", cwd: source, args });
        yield* driver.createWorktree({
          cwd: source,
          refName: "main",
          newRefName: "feature",
          path: target,
        });
        const project = { ...makeProject([]), workspaceRoot: source };
        const result = yield* Effect.gen(function* () {
          const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
          return yield* runner.runForThread({
            threadId: "thread-1",
            projectId: project.id,
            worktreePath: target,
          });
        }).pipe(
          Effect.provide(
            testLayer(
              project,
              {
                open: () => Effect.die("setup must not launch"),
                write: () => Effect.die("setup must not launch"),
              },
              ServerSettings.layerTest({
                projectSettingsOverrides: { [project.id]: { defaultProjectScripts: [] } },
              }),
            ),
          ),
        );
        expect(result.status).toBe("no-script");
        expect(yield* fs.exists(path.join(target, "node_modules"))).toBe(false);
        const fileClone = yield* makeFileClone();
        const probe = yield* fileClone
          .clone([path.join(source, "package.json")], root)
          .pipe(Effect.result);
        const setup = {
          id: "install",
          name: "Install",
          command: "npm ci",
          icon: "configure" as const,
          runOnWorktreeCreate: true,
        };
        const started = yield* Effect.gen(function* () {
          const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
          return yield* runner.runForThread({
            threadId: "thread-1",
            projectId: project.id,
            worktreePath: target,
          });
        }).pipe(
          Effect.provide(
            testLayer(
              project,
              {
                open: () =>
                  Effect.gen(function* () {
                    expect(
                      yield* fs
                        .exists(path.join(target, "node_modules", "pkg", "index.js"))
                        .pipe(Effect.orDie),
                    ).toBe(probe._tag === "Success");
                    return {
                      threadId: "thread-1",
                      terminalId: "setup-install",
                      cwd: target,
                      worktreePath: target,
                      status: "running" as const,
                      pid: 123,
                      history: "",
                      exitCode: null,
                      exitSignal: null,
                      label: "setup-install",
                      updatedAt: "2026-01-01T00:00:00.000Z",
                    };
                  }),
                write: () => Effect.void,
              },
              ServerSettings.layerTest({
                projectSettingsOverrides: { [project.id]: { defaultProjectScripts: [setup] } },
              }),
            ),
          ),
        );
        expect(started.status).toBe("started");
      }).pipe(Effect.provide(GitTestLayer)),
  );

  it.effect("runs the inherited machine setup action in the checkout's worktree", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-default-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toMatchObject({ status: "started", scriptId: "default-setup" });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        data: "npm install\r",
      });
    }).pipe(
      Effect.provide(
        testLayer(
          makeProject([]),
          { open, write },
          ServerSettings.layerTest({
            defaultProjectScripts: [
              {
                id: "default-setup",
                name: "Setup",
                command: "npm install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          }),
        ),
      ),
    );
  });

  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
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
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "bun install",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          async: true,
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: "bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect(
    "wraps the command with a completion sentinel and resolves the exit code from terminal output",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
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
        }),
      );
      const writes: string[] = [];
      const write = vi.fn((input: { data: string }) =>
        Effect.sync(() => void writes.push(input.data)),
      );
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
        listener = next;
        return Effect.succeed(() => {
          listener = null;
        });
      });
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const emit = (data: string) =>
        Effect.suspend(() =>
          listener
            ? listener({ threadId: "thread-1", terminalId: "setup-setup", type: "output", data })
            : Effect.void,
        );

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const seen: string[] = [];
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {
            onOutputLine: (line) => Effect.sync(() => void seen.push(line)),
          },
        });
        expect(result.status).toBe("started");
        if (result.status !== "started") return;
        expect(result.completion).toBeDefined();

        // The subscription is attached before the command is written.
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
        // The block closes on its own line so a trailing comment in the
        // command cannot swallow the sentinel, and the sentinel carries a
        // per-run token so script output cannot spoof it.
        const written = writes[0] ?? "";
        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        expect(written).toBe(`( bun install\r); printf '\\n${sentinel}%s\\n' "$?"\r`);

        // Output arrives in chunks; partial lines are buffered until a newline,
        // control sequences are stripped, and the echoed wrapper is hidden.
        yield* emit(`( bun install\r\n> ); printf '\\n${sentinel}%s\\n' "$?"\r\n`);
        yield* emit("\u001b[32mResolving");
        yield* emit(" deps\u001b[0m\r\n");
        // Progress redraws separated by bare carriage returns are their own lines.
        yield* emit("Progress: 1/3\rProgress: 2/3\rProgress: 3/3\r\nDone in 2s\r\n");
        // A spoofed sentinel from the script itself must not settle completion.
        yield* emit("__T3_SETUP_DONE__:0\r\n");
        yield* emit(`__T3_SETUP_DONE___${"0".repeat(32)}:0\r\n`);
        yield* emit(`${sentinel}3\r\n`);

        const completion = yield* result.completion!;
        expect(completion.exitCode).toBe(3);
        expect(seen).toEqual([
          "Resolving deps",
          "Progress: 1/3",
          "Progress: 2/3",
          "Progress: 3/3",
          "Done in 2s",
          "__T3_SETUP_DONE__:0",
          `__T3_SETUP_DONE___${"0".repeat(32)}:0`,
        ]);
        // The subscription is torn down once the sentinel arrives.
        expect(listener).toBeNull();
      }).pipe(
        Effect.provide(testLayer(project, { open, write, subscribe })),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/zsh" }),
      );
    },
  );

  it.effect("unsubscribes from terminal output when the command cannot be written", () => {
    const open = vi.fn(() =>
      Effect.succeed({
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
      }),
    );
    const write = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalCwdStatError({ cwd: "/repo/worktrees/a", cause: {} }),
      ),
    );
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => Effect.succeed(unsubscribe));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe })));
  });

  it.effect.each([
    {
      shell: "/usr/bin/fish",
      expected:
        /^begin\rbun install\rend; printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' \$status\r$/,
    },
    {
      shell: "/bin/bash",
      expected: /^\( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
    },
  ])("wraps the command for the $shell syntax", ({ shell, expected }) => {
    const open = vi.fn(() =>
      Effect.succeed({
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
      }),
    );
    const writes: string[] = [];
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void writes.push(input.data)),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(expected);
    }).pipe(
      Effect.provide(testLayer(project, { open, write })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: shell }),
    );
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

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
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
});
