import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import { resolveWorkbench } from "@t3tools/client-runtime/state/task-workbench";
import {
  executeProjectScript,
  resolveProjectScriptLaunch,
  scriptNeedsNewTerminal,
  workbenchLaunchKey,
} from "./projectScriptExecution";

const environmentId = EnvironmentId.make("one");
const project = {
  environmentId,
  id: ProjectId.make("primary"),
  workspaceRoot: "/primary",
  scripts: [
    {
      id: "dev",
      name: "Dev",
      command: "primary-dev",
      icon: "debug" as const,
      runOnWorktreeCreate: false,
    },
  ],
};
const memberProject = {
  ...project,
  id: ProjectId.make("foreign"),
  workspaceRoot: "/foreign",
  scripts: [{ ...project.scripts[0]!, id: "foreign-only", command: "foreign-dev" }],
};
const input = {
  threadRef: { environmentId, threadId: ThreadId.make("member") },
  thread: {
    environmentId,
    projectId: memberProject.id,
    taskId: TaskId.make("task"),
    worktreePath: "/foreign-checkout",
  },
  task: { environmentId, id: TaskId.make("task"), primaryProjectId: project.id },
  tasksSupported: true,
  authoritative: true,
  projects: [project, memberProject],
};
const workbench = resolveWorkbench(input);

describe("project script execution", () => {
  it("selects the primary command, edit destination, cwd, runtime env and task owner together", () => {
    expect(resolveProjectScriptLaunch({ workbench, project, scriptId: "dev" })).toMatchObject({
      ownerRef: { environmentId, threadId: "task:task" },
      projectRef: { environmentId, projectId: project.id },
      projectCwd: "/primary",
      cwd: "/primary",
      worktreePath: null,
      env: { T3CODE_PROJECT_ROOT: "/primary" },
      script: { command: "primary-dev" },
    });
    expect(resolveProjectScriptLaunch({ workbench, project, scriptId: "foreign-only" })).toBeNull();
    expect(
      resolveProjectScriptLaunch({ workbench, project: memberProject, scriptId: "foreign-only" }),
    ).toBeNull();
    expect(
      resolveProjectScriptLaunch({
        workbench,
        project: { ...project, environmentId: EnvironmentId.make("two") },
        scriptId: "dev",
      }),
    ).toBeNull();
  });
  it("never opens a terminal for unavailable context", async () => {
    const unavailable = resolveWorkbench({ ...input, authoritative: false });
    expect(
      resolveProjectScriptLaunch({ workbench: unavailable, project, scriptId: "dev" }),
    ).toBeNull();
    const open = vi.fn(async () => true);
    await executeProjectScript({
      isCurrent: () => workbenchLaunchKey(unavailable) !== null,
      open,
      write: vi.fn(),
    });
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["primary-project", "task", "environment", "cached", "capability"])(
    "cancels a prepared command after %s changes",
    async (change) => {
      let release!: (value: boolean) => void;
      const preparation = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      let current = workbench;
      const capturedKey = workbenchLaunchKey(workbench);
      const write = vi.fn(async () => {});
      const run = executeProjectScript({
        isCurrent: () => workbenchLaunchKey(current) === capturedKey,
        open: () => preparation,
        write,
      });
      current =
        change === "cached"
          ? resolveWorkbench({ ...input, authoritative: false })
          : change === "capability"
            ? resolveWorkbench({ ...input, tasksSupported: undefined })
            : change === "primary-project"
              ? resolveWorkbench({
                  ...input,
                  task: { ...input.task, primaryProjectId: memberProject.id },
                })
              : change === "task"
                ? resolveWorkbench({
                    ...input,
                    thread: { ...input.thread, taskId: TaskId.make("other") },
                    task: { ...input.task, id: TaskId.make("other") },
                  })
                : resolveWorkbench({
                    ...input,
                    task: { ...input.task, environmentId: EnvironmentId.make("two") },
                  });
      release(true);
      await run;
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("writes the captured command only after a successful, still-current open", async () => {
    const operations: string[] = [];
    const launch = resolveProjectScriptLaunch({ workbench, project, scriptId: "dev" })!;
    await executeProjectScript({
      isCurrent: () => true,
      open: async () => {
        operations.push(launch.cwd);
        return true;
      },
      write: async () => {
        operations.push(launch.script.command);
      },
    });
    expect(operations).toEqual(["/primary", "primary-dev"]);
  });
  it("does not reuse busy, unknown-cwd or previous-primary terminals", () => {
    expect(
      scriptNeedsNewTerminal({
        busy: true,
        knownTerminal: true,
        existingCwd: "/primary",
        cwd: "/primary",
      }),
    ).toBe(true);
    expect(
      scriptNeedsNewTerminal({
        busy: false,
        knownTerminal: true,
        existingCwd: undefined,
        cwd: "/primary",
      }),
    ).toBe(true);
    expect(
      scriptNeedsNewTerminal({
        busy: false,
        knownTerminal: true,
        existingCwd: "/old",
        cwd: "/primary",
      }),
    ).toBe(true);
    expect(
      scriptNeedsNewTerminal({
        busy: false,
        knownTerminal: true,
        existingCwd: "/primary",
        cwd: "/primary",
      }),
    ).toBe(false);
  });
});
