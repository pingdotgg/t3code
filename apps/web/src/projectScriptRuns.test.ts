// @effect-diagnostics nodeBuiltinImport:off - executes the wrapper in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import { startProjectScriptRunCoordinator } from "./components/projectScriptRuns/ProjectScriptRunCoordinator";
import { terminalEnvironment } from "./state/terminal";
import { useProjectScriptRunsStore } from "./projectScriptRunsStore";

vi.mock("./state/terminal", () => ({ terminalEnvironment: { observe: vi.fn(), close: {} } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn().mockResolvedValue({ _tag: "Success", value: undefined }),
}));

import {
  isProjectScriptWrapperLine,
  projectScriptBeginMarker,
  projectScriptLaunchKey,
  projectScriptOutputTail,
  projectScriptSentinelPattern,
  projectScriptStopRollbackPatch,
  projectScriptStoppedPatch,
  projectScriptVisibleOutput,
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
    expect(isProjectScriptWrapperLine("[~/project] sh -c 'pnpm test'")).toBe(true);
    expect(isProjectScriptWrapperLine("quote> __t3_status=$?")).toBe(true);
    expect(isProjectScriptWrapperLine('printf "$__T3_SCRIPT_SENTINEL"')).toBe(true);
    expect(isProjectScriptWrapperLine("pnpm test failed")).toBe(false);
  });

  it("shows output after the begin marker without the wrapper or end sentinel", () => {
    const sentinel = "__T3_SCRIPT_DONE__token:";
    const text = [
      '[~/project] sh -c \'printf "\\n%s\\n" "$__T3_SCRIPT_BEGIN"',
      "quote> (",
      "quote> pnpm test",
      "quote> )",
      "quote> __t3_status=$?",
      projectScriptBeginMarker(sentinel),
      "first line",
      "second line",
      `${sentinel}0`,
      "[~/project]",
    ].join("\r\n");

    expect(projectScriptVisibleOutput(text, sentinel)).toBe("first line\nsecond line");
    expect(projectScriptVisibleOutput("plain output", sentinel)).toBe("plain output");
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

  it("does not replace completion recorded while Stop is pending", () => {
    const runId = "stop-race";
    const activeRun = run({ id: runId, status: "running", startedAt: 0 });
    useProjectScriptRunsStore.setState({ runs: { [runId]: activeRun } });
    useProjectScriptRunsStore.getState().updateRun(runId, {
      status: "succeeded",
      exitCode: 0,
      endedAt: 10,
    });

    const currentRun = useProjectScriptRunsStore.getState().runs[runId]!;
    const stoppedPatch = projectScriptStoppedPatch(currentRun, 20);
    if (stoppedPatch !== null) {
      useProjectScriptRunsStore.getState().updateRun(runId, stoppedPatch);
    }

    expect(useProjectScriptRunsStore.getState().runs[runId]).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      endedAt: 10,
    });
    useProjectScriptRunsStore.setState({ runs: {} });
  });

  it("restores the active run if terminal close fails", () => {
    const activeRun = run({ id: "stop-failure", status: "running", startedAt: 0 });
    const stoppedRun = {
      ...activeRun,
      status: "stopped" as const,
      endedAt: 20,
    };

    expect(projectScriptStopRollbackPatch(stoppedRun, activeRun)).toEqual({
      status: "running",
      errorMessage: null,
      exitCode: null,
      endedAt: null,
    });
    expect(
      projectScriptStopRollbackPatch({ ...activeRun, status: "succeeded" }, activeRun),
    ).toBeNull();
  });

  it("claims only one pending launch for a project action", () => {
    const key = projectScriptLaunchKey(environmentId, projectId, "dev");
    const store = useProjectScriptRunsStore.getState();

    expect(store.beginLaunch(key)).toBe(true);
    expect(useProjectScriptRunsStore.getState().beginLaunch(key)).toBe(false);

    store.endLaunch(key);
    expect(useProjectScriptRunsStore.getState().pendingLaunchKeys.has(key)).toBe(false);
    expect(useProjectScriptRunsStore.getState().beginLaunch(key)).toBe(true);
    useProjectScriptRunsStore.getState().endLaunch(key);
  });

  it("wraps headless actions in a shell-portable child shell", () => {
    expect(wrapProjectScriptCommand("pnpm dev", "/usr/bin/fish")).toMatch(/^sh -c /);
  });
});

it.each([0, 7, null])("reads buffered completion before shell exit (%s)", (exitCode) => {
  const registry = AtomRegistry.make();
  const currentRun = run({ id: "buffered", status: "starting", startedAt: 0 });
  const text =
    projectScriptBeginMarker(currentRun.sentinel) +
    "\noutput\n" +
    (exitCode === null ? "" : currentRun.sentinel + exitCode + "\n");
  const atom = Atom.make(
    AsyncResult.success({
      ...EMPTY_TERMINAL_BUFFER_STATE,
      status: "exited" as const,
      output: {
        ...EMPTY_TERMINAL_BUFFER_STATE.output,
        chunks: [{ startOffset: 0, data: text, byteLength: text.length }],
        retainedBytes: text.length,
        nextOffset: text.length,
      },
    }),
  );
  vi.mocked(terminalEnvironment.observe).mockReturnValue(atom);
  useProjectScriptRunsStore.setState({ runs: { [currentRun.id]: currentRun } });
  const stop = startProjectScriptRunCoordinator(registry);
  try {
    expect(useProjectScriptRunsStore.getState().runs[currentRun.id]).toMatchObject({
      status: exitCode === 0 ? "succeeded" : "failed",
      exitCode,
      outputTail: "output",
    });
  } finally {
    stop();
    registry.dispose();
    useProjectScriptRunsStore.setState({ runs: {}, pendingStopRunIds: new Set() });
  }
});

it("records a requested stop when the terminal closes", () => {
  const registry = AtomRegistry.make();
  const currentRun = run({ id: "requested-stop", status: "running", startedAt: 0 });
  const atom = Atom.make(
    AsyncResult.success({
      ...EMPTY_TERMINAL_BUFFER_STATE,
      status: "closed" as const,
    }),
  );
  vi.mocked(terminalEnvironment.observe).mockReturnValue(atom);
  useProjectScriptRunsStore.setState({
    runs: { [currentRun.id]: currentRun },
    pendingStopRunIds: new Set([currentRun.id]),
  });
  const stop = startProjectScriptRunCoordinator(registry);
  try {
    expect(useProjectScriptRunsStore.getState().runs[currentRun.id]).toMatchObject({
      status: "stopped",
      exitCode: null,
      errorMessage: null,
    });
  } finally {
    stop();
    registry.dispose();
    useProjectScriptRunsStore.setState({ runs: {}, pendingStopRunIds: new Set() });
  }
});

it("keeps completion observed while a requested stop is pending", () => {
  const registry = AtomRegistry.make();
  const currentRun = run({ id: "stop-completion", status: "running", startedAt: 0 });
  const text =
    projectScriptBeginMarker(currentRun.sentinel) + "\noutput\n" + currentRun.sentinel + "0\n";
  const atom = Atom.make(
    AsyncResult.success({
      ...EMPTY_TERMINAL_BUFFER_STATE,
      status: "closed" as const,
      output: {
        ...EMPTY_TERMINAL_BUFFER_STATE.output,
        chunks: [{ startOffset: 0, data: text, byteLength: text.length }],
        retainedBytes: text.length,
        nextOffset: text.length,
      },
    }),
  );
  vi.mocked(terminalEnvironment.observe).mockReturnValue(atom);
  useProjectScriptRunsStore.setState({
    runs: { [currentRun.id]: currentRun },
    pendingStopRunIds: new Set([currentRun.id]),
  });
  const stop = startProjectScriptRunCoordinator(registry);
  try {
    expect(useProjectScriptRunsStore.getState().runs[currentRun.id]).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      outputTail: "output",
    });
  } finally {
    stop();
    registry.dispose();
    useProjectScriptRunsStore.setState({ runs: {}, pendingStopRunIds: new Set() });
  }
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("POSIX project commands", () => {
  it.each(["/bin/bash", "/bin/zsh"])("runs commands in %s and reports the exit code", (shell) => {
    const wrapped = wrapProjectScriptCommand("greet; [[ 1 == 1 ]]; exit 7", shell);
    const output = NodeChildProcess.execFileSync(
      "bash",
      ["-c", "greet() { printf 'hello\\n'; };\n" + wrapped],
      {
        env: {
          PATH: HostProcess.Environment.defaultValue().PATH,
          __T3_SCRIPT_BEGIN: "begin",
          __T3_SCRIPT_SENTINEL: "done:",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("hello");
    expect(output).toContain("done:7");
  });

  it.each(["/usr/bin/fish", null])(
    "runs quoted commands through the fallback shell (%s)",
    (shell) => {
      const output = NodeChildProcess.execFileSync(
        "sh",
        ["-c", wrapProjectScriptCommand("printf '%s' \"it's working\"", shell)],
        {
          env: {
            PATH: HostProcess.Environment.defaultValue().PATH,
            __T3_SCRIPT_BEGIN: "begin",
            __T3_SCRIPT_SENTINEL: "done:",
          },
          encoding: "utf8",
        },
      );
      expect(output).toContain("it's working");
      expect(output).toContain("done:0");
    },
  );
});
