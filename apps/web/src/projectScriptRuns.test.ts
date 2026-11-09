import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isProjectScriptWrapperLine,
  projectScriptOutputTail,
  projectScriptSentinelPattern,
  resolveProjectAnchorThread,
  sortProjectScriptMenuEntries,
  sortProjectScriptRuns,
  stripProjectScriptOutput,
  wrapProjectScriptCommand,
  type ProjectScriptMenuEntry,
  type ProjectScriptRun,
} from "./projectScriptRuns";

const environmentId = "env-1" as EnvironmentId;
const projectId = "project-1" as ProjectId;

function thread(
  overrides: Partial<Omit<EnvironmentThreadShell, "id">> & { readonly id: string },
): EnvironmentThreadShell {
  const { id, ...rest } = overrides;
  return {
    environmentId,
    projectId,
    title: id,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: null,
    unsettledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...rest,
    id: id as ThreadId,
  } as unknown as EnvironmentThreadShell;
}

function project(id: string, title: string): EnvironmentProject {
  return {
    id: id as ProjectId,
    environmentId,
    title,
    workspaceRoot: `/work/${id}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
  } as unknown as EnvironmentProject;
}

function run(
  overrides: Partial<ProjectScriptRun> & Pick<ProjectScriptRun, "id" | "status" | "startedAt">,
): ProjectScriptRun {
  return {
    environmentId,
    projectId,
    projectTitle: "Project",
    scriptId: overrides.id,
    scriptName: overrides.id,
    command: "true",
    threadId: "thread-1" as ThreadId,
    threadTitle: "Thread",
    threadScoped: true,
    terminalId: `terminal-${overrides.id}`,
    cwd: "/work/project",
    worktreePath: null,
    sentinel: "__T3_SCRIPT_DONE__token:",
    exitCode: null,
    errorMessage: null,
    outputTail: "",
    endedAt: null,
    ...overrides,
  } as unknown as ProjectScriptRun;
}

describe("project script runs", () => {
  it("wraps a command with a sentinel read from the environment", () => {
    const wrapped = wrapProjectScriptCommand("pnpm test");

    expect(wrapped).toBe(
      'sh -c \'pnpm test\r__t3_status=$?\rprintf "\\n%s%s\\n" "$__T3_SCRIPT_SENTINEL" "$__t3_status"\'',
    );
  });

  it("escapes single quotes and keeps multi-line commands", () => {
    const wrapped = wrapProjectScriptCommand("echo 'hi'\npnpm build");

    expect(wrapped).toContain("echo '\\''hi'\\''");
    expect(wrapped).toContain("echo '\\''hi'\\''\rpnpm build");
  });

  it("parses only the sentinel with its token", () => {
    const pattern = projectScriptSentinelPattern("__T3_SCRIPT_DONE__abc:");

    expect(pattern.exec("__T3_SCRIPT_DONE__abc:0")?.[1]).toBe("0");
    expect(pattern.exec("__T3_SCRIPT_DONE__abc:-2")?.[1]).toBe("-2");
    expect(pattern.exec("__T3_SCRIPT_DONE__other:0")).toBeNull();
    expect(pattern.exec("$__T3_SCRIPT_SENTINEL:0")).toBeNull();
  });

  it("strips terminal control codes and keeps the tail", () => {
    const text = "\x1b[31mfirst\x1b[0m\nsecond\nthird\n";

    expect(stripProjectScriptOutput(text)).toBe("first\nsecond\nthird\n");
    expect(projectScriptOutputTail(text, 2)).toBe("second\nthird");
  });

  it("recognizes the echoed wrapper lines", () => {
    expect(isProjectScriptWrapperLine(" sh -c 'pnpm test'")).toBe(true);
    expect(isProjectScriptWrapperLine('printf "$__T3_SCRIPT_SENTINEL"')).toBe(true);
    expect(isProjectScriptWrapperLine("pnpm test failed")).toBe(false);
  });

  it("picks the most recently active thread and ignores archived threads", () => {
    const older = thread({
      id: "older",
      settledAt: "2026-01-02T00:00:00.000Z",
    });
    const newer = thread({
      id: "newer",
      unsettledAt: "2026-02-01T00:00:00.000Z",
    });
    const archived = thread({
      id: "archived",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });

    expect(resolveProjectAnchorThread([older, newer, archived])?.id).toBe("newer");
    expect(resolveProjectAnchorThread([])).toBeNull();
  });

  it("orders menu entries by project activity", () => {
    const entries: ProjectScriptMenuEntry[] = [
      {
        project: project("slow", "Slow"),
        scripts: [],
        anchorThread: null,
        environmentLabel: "Local",
        lastActivity: 1,
        canOperate: true,
      },
      {
        project: project("fast", "Fast"),
        scripts: [],
        anchorThread: null,
        environmentLabel: "Local",
        lastActivity: 3,
        canOperate: true,
      },
    ];

    expect(sortProjectScriptMenuEntries(entries).map((entry) => entry.project.title)).toEqual([
      "Fast",
      "Slow",
    ]);
  });

  it("puts failures and active runs before finished runs", () => {
    const runs = [
      run({ id: "succeeded", status: "succeeded", startedAt: 5 }),
      run({ id: "failed", status: "failed", startedAt: 1 }),
      run({ id: "running", status: "running", startedAt: 2 }),
      run({ id: "starting", status: "starting", startedAt: 4 }),
    ];

    expect(sortProjectScriptRuns(runs).map((entry) => entry.id)).toEqual([
      "failed",
      "running",
      "starting",
      "succeeded",
    ]);
  });
});
