import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";

import { useMessages } from "gt-react-native";

import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import type { useThreadSelection } from "../../state/use-thread-selection";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "./terminalLaunchContext";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "./terminalMenu";

type ThreadSelection = ReturnType<typeof useThreadSelection>;

export interface ThreadTerminalTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId?: string;
}

/** The thread's terminal options and the actions that open a terminal, for the thread screen and the Terminal sheet. */
export function useThreadTerminalControls(input: {
  readonly thread: ThreadSelection["selectedThread"];
  readonly project: ThreadSelection["selectedThreadProject"];
  readonly serverSettings: Parameters<typeof resolveProjectScripts>[0] | null;
  readonly threadDetailWorktreePath: string | null;
  readonly openTerminal: (target: ThreadTerminalTarget) => void;
}) {
  const { thread, project } = input;
  const m = useMessages();
  const canReadTerminal = useEnvironmentScope(thread?.environmentId ?? null, AuthTerminalReadScope);
  const canOperateTerminal = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const { sessions: knownSessions } = useKnownTerminalSessions({
    environmentId: thread?.environmentId ?? null,
    threadId: thread?.id ?? null,
  });
  const terminalSessions = buildTerminalMenuSessions(
    { knownSessions: knownSessions ?? [], workspaceRoot: project?.workspaceRoot ?? null },
    m,
  );
  const projectScripts = project
    ? resolveProjectScripts(input.serverSettings ?? DEFAULT_SERVER_SETTINGS, project)
    : [];
  // Without a session list, a random suffix keeps the new id from colliding.
  const uniqueSuffixIfUnlisted = () =>
    thread === null ||
    knownSessions === null ||
    !readEnvironmentScope(thread.environmentId, AuthTerminalReadScope)
      ? { uniqueSuffix: uuidv4() }
      : {};

  const onOpenTerminal = (terminalId?: string | null) => {
    if (
      !thread ||
      !project?.workspaceRoot ||
      (!readEnvironmentScope(thread.environmentId, AuthTerminalReadScope) &&
        !readEnvironmentScope(thread.environmentId, AuthTerminalOperateScope))
    ) {
      return;
    }
    input.openTerminal({
      environmentId: String(thread.environmentId),
      threadId: String(thread.id),
      ...(terminalId ? { terminalId } : {}),
    });
  };

  const onOpenNewTerminal = () => {
    if (
      !thread ||
      !project?.workspaceRoot ||
      !readEnvironmentScope(thread.environmentId, AuthTerminalOperateScope)
    ) {
      return;
    }
    input.openTerminal({
      environmentId: String(thread.environmentId),
      threadId: String(thread.id),
      terminalId: nextOpenTerminalId({
        listedTerminalIds: terminalSessions.map((session) => session.terminalId),
        ...uniqueSuffixIfUnlisted(),
      }),
    });
  };

  const onRunProjectScript = async (script: ProjectScript) => {
    if (
      !thread ||
      !project?.workspaceRoot ||
      !readEnvironmentScope(thread.environmentId, AuthTerminalOperateScope)
    ) {
      return;
    }
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: terminalSessions.map((session) => session.terminalId),
      ...uniqueSuffixIfUnlisted(),
      hasRunningTerminal: terminalSessions.some(
        (session) => session.status === "running" || session.status === "starting",
      ),
    });
    const worktreePath = resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: thread.worktreePath ?? null,
      threadDetailWorktreePath: input.threadDetailWorktreePath,
    });
    const scriptProject = { cwd: project.workspaceRoot };
    stagePendingTerminalLaunch({
      target: { environmentId: thread.environmentId, threadId: thread.id, terminalId },
      launch: {
        cwd: projectScriptCwd({ project: scriptProject, worktreePath }),
        worktreePath,
        env: projectScriptRuntimeEnv({ project: scriptProject, worktreePath }),
        initialInput: projectScriptTerminalInput(script.command),
        stopOnSettle: script.stopOnSettle ?? false,
      },
    });
    input.openTerminal({
      environmentId: String(thread.environmentId),
      threadId: String(thread.id),
      terminalId,
    });
  };

  return {
    canOpenTerminal: Boolean(project?.workspaceRoot) && (canReadTerminal || canOperateTerminal),
    canOperateTerminal,
    projectScripts,
    terminalSessions,
    onOpenTerminal,
    onOpenNewTerminal,
    onRunProjectScript,
  };
}
