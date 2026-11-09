import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";

import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import {
  isProjectScriptRunActive,
  PROJECT_SCRIPT_BEGIN_ENV,
  PROJECT_SCRIPT_SENTINEL_ENV,
  PROJECT_SCRIPT_SENTINEL_PREFIX,
  projectActionsThreadId,
  projectLastActivityTimestamp,
  projectScriptBeginMarker,
  resolveProjectAnchorThread,
  sortProjectScriptMenuEntries,
  sortProjectScriptRuns,
  wrapProjectScriptCommand,
  type ProjectScriptMenuEntry,
  type ProjectScriptRun,
} from "../projectScriptRuns";
import { useProjectScriptRunsStore } from "../projectScriptRunsStore";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { useEnvironmentIdentities } from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams } from "../threadRoutes";

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

function commandFailureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The action could not start.";
}

export function useProjectScriptRunActions() {
  const projects = useProjects();
  const operateScopes = useEnvironmentsWithScope(projects, AuthTerminalOperateScope);
  const readScopes = useEnvironmentsWithScope(projects, AuthTerminalReadScope);
  const openTerminal = useAtomCommand(terminalEnvironment.open, "project action open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "project action write");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "project action close");
  const navigate = useNavigate();
  const runs = useProjectScriptRunsStore((state) => state.runs);
  const selectedRunId = useProjectScriptRunsStore((state) => state.selectedRunId);
  const startRun = useProjectScriptRunsStore((state) => state.startRun);
  const updateRun = useProjectScriptRunsStore((state) => state.updateRun);
  const removeRun = useProjectScriptRunsStore((state) => state.removeRun);
  const clearFinished = useProjectScriptRunsStore((state) => state.clearFinished);
  const selectRun = useProjectScriptRunsStore((state) => state.selectRun);

  const runsList = sortProjectScriptRuns(Object.values(runs));
  const selectedRun = selectedRunId === null ? null : (runs[selectedRunId] ?? null);
  const canOperate = (environmentId: EnvironmentId) => operateScopes.has(environmentId);
  const canRead = (environmentId: EnvironmentId) => readScopes.has(environmentId);
  const projectForRun = (run: ProjectScriptRun) =>
    projects.find(
      (project) => project.environmentId === run.environmentId && project.id === run.projectId,
    ) ?? null;

  const runScript = async (
    project: EnvironmentProject,
    script: ProjectScript,
    anchorThread: EnvironmentThreadShell | null,
  ) => {
    if (!canOperate(project.environmentId) || !canRead(project.environmentId)) {
      toastManager.add({
        type: "error",
        title: "Cannot run project actions",
        description: "This connection needs terminal read and operate permissions.",
      });
      return;
    }

    const runId = randomUUID();
    const terminalId = `script-${script.id}-${runId.slice(0, 8)}`;
    const sentinel = `${PROJECT_SCRIPT_SENTINEL_PREFIX}${runId.replaceAll("-", "")}:`;
    const worktreePath = anchorThread?.worktreePath ?? null;
    const cwd = worktreePath ?? project.workspaceRoot;
    const threadId = anchorThread?.id ?? projectActionsThreadId(project.environmentId, project.id);
    const threadTitle = anchorThread?.title ?? project.title;
    const run: ProjectScriptRun = {
      id: runId,
      environmentId: project.environmentId,
      projectId: project.id,
      projectTitle: project.title,
      scriptId: script.id,
      scriptName: script.name,
      command: script.command,
      threadId,
      threadTitle,
      threadScoped: anchorThread !== null,
      terminalId,
      cwd,
      worktreePath,
      sentinel,
      startedAt: Date.now(),
      status: "starting",
      exitCode: null,
      errorMessage: null,
      outputTail: "",
      endedAt: null,
    };

    const openResult = await openTerminal({
      environmentId: project.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(worktreePath !== null ? { worktreePath } : {}),
        cols: SCRIPT_TERMINAL_COLS,
        rows: SCRIPT_TERMINAL_ROWS,
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath,
          extraEnv: {
            [PROJECT_SCRIPT_BEGIN_ENV]: projectScriptBeginMarker(sentinel),
            [PROJECT_SCRIPT_SENTINEL_ENV]: sentinel,
            COLORTERM: "",
          },
        }),
      },
    });
    if (openResult._tag === "Failure") {
      const message = isAtomCommandInterrupted(openResult)
        ? "The run was interrupted."
        : commandFailureMessage(openResult);
      startRun({ ...run, status: "failed", errorMessage: message, endedAt: Date.now() });
      toastManager.add({
        type: "error",
        title: `Could not run ${script.name}`,
        description: message,
      });
      return;
    }

    startRun(run);
    const writeResult = await writeTerminal({
      environmentId: project.environmentId,
      input: {
        threadId,
        terminalId,
        data: projectScriptTerminalInput(wrapProjectScriptCommand(script.command)),
      },
    });
    if (writeResult._tag === "Failure") {
      const message = isAtomCommandInterrupted(writeResult)
        ? "The run was interrupted."
        : commandFailureMessage(writeResult);
      updateRun(runId, { status: "failed", errorMessage: message, endedAt: Date.now() });
      toastManager.add({
        type: "error",
        title: `Could not run ${script.name}`,
        description: message,
      });
    }
  };

  const stopRun = async (run: ProjectScriptRun) => {
    if (!isProjectScriptRunActive(run)) return;
    updateRun(run.id, { status: "stopped", endedAt: Date.now() });
    const closeResult = await closeTerminal({
      environmentId: run.environmentId,
      input: { threadId: run.threadId, terminalId: run.terminalId, deleteHistory: false },
    });
    if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
      await writeTerminal({
        environmentId: run.environmentId,
        input: { threadId: run.threadId, terminalId: run.terminalId, data: "exit\n" },
      });
    }
  };

  const dismissRun = (run: ProjectScriptRun) => {
    removeRun(run.id);
    void closeTerminal({
      environmentId: run.environmentId,
      input: { threadId: run.threadId, terminalId: run.terminalId, deleteHistory: true },
    });
  };

  const clearFinishedRuns = () => {
    for (const run of Object.values(runs)) {
      if (isProjectScriptRunActive(run)) continue;
      void closeTerminal({
        environmentId: run.environmentId,
        input: { threadId: run.threadId, terminalId: run.terminalId, deleteHistory: true },
      });
    }
    clearFinished();
  };

  const openRunInTerminal = (run: ProjectScriptRun) => {
    const threadRef = scopeThreadRef(run.environmentId, run.threadId);
    useTerminalUiStateStore
      .getState()
      .ensureTerminal(threadRef, run.terminalId, { open: true, active: true });
    selectRun(null);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  return {
    runs,
    runsList,
    selectedRun,
    activeRunCount: runsList.filter(isProjectScriptRunActive).length,
    canOperate,
    projectForRun,
    runScript,
    stopRun,
    dismissRun,
    clearFinishedRuns,
    openRunInTerminal,
    selectRun,
  };
}

export function useProjectScriptMenuEntries(): {
  readonly entries: ReadonlyArray<ProjectScriptMenuEntry>;
  readonly showEnvironmentLabel: boolean;
} {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const configs = useServerConfigs();
  const identities = useEnvironmentIdentities();
  const operateScopes = useEnvironmentsWithScope(projects, AuthTerminalOperateScope);
  const labels = new Map(
    identities.map((identity) => [identity.environmentId, identity.label] as const),
  );
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const key = `${thread.environmentId}\u0000${thread.projectId}`;
    const existing = threadsByProject.get(key);
    if (existing === undefined) threadsByProject.set(key, [thread]);
    else existing.push(thread);
  }

  const entries: ProjectScriptMenuEntry[] = [];
  for (const project of projects) {
    if (project.archivedAt != null || project.isScratch === true) continue;
    const settings = configs.get(project.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const scripts = resolveProjectScripts(settings, project);
    if (scripts.length === 0) continue;
    const projectThreads =
      threadsByProject.get(`${project.environmentId}\u0000${project.id}`) ?? [];
    entries.push({
      project,
      scripts,
      anchorThread: resolveProjectAnchorThread(projectThreads),
      environmentLabel: labels.get(project.environmentId) ?? "",
      lastActivity: projectLastActivityTimestamp(project, projectThreads),
      canOperate: operateScopes.has(project.environmentId),
    });
  }

  return {
    entries: sortProjectScriptMenuEntries(entries),
    showEnvironmentLabel: identities.length > 1,
  };
}
