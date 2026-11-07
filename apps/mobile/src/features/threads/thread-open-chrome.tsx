import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";

import type { ThreadGitControlsProps } from "./ThreadGitControls";
import type { TerminalMenuSession } from "../terminal/terminalMenu";

const noop = () => {};
const asyncNoop = async () => {};

/** Git/terminal props that reserve AppBar menu slots before live chrome is ready. */
export function threadOpenGitControls(input: {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly currentBranch: string | null;
  readonly hasWorkspace: boolean;
  readonly canOperateTerminal?: boolean;
  readonly canOpenFiles?: boolean;
  readonly projectScripts?: ReadonlyArray<ProjectScript>;
  readonly terminalSessions?: ReadonlyArray<TerminalMenuSession>;
}): ThreadGitControlsProps {
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
    currentBranch: input.currentBranch,
    gitStatus: null,
    gitOperationLabel: null,
    // Match live: terminal menu exists whenever the project has a workspace root.
    canOpenTerminal: input.hasWorkspace,
    canOperateTerminal: input.canOperateTerminal ?? false,
    canOpenFiles: input.canOpenFiles ?? false,
    projectScripts: input.projectScripts ?? [],
    terminalSessions: input.terminalSessions ?? [],
    // Leave onOpenGitInspector unset so useThreadGitControlModel navigates to GitOverview.
    onOpenTerminal: noop,
    onOpenNewTerminal: noop,
    onRunProjectScript: asyncNoop,
    onPull: asyncNoop,
    onRunAction: async () => null,
  };
}

/** Draft open shell: git menu + files action, no terminal (same as live DraftThreadHeader). */
export function draftOpenGitControls(): ThreadGitControlsProps {
  return {
    ...threadOpenGitControls({
      environmentId: "",
      threadId: "",
      currentBranch: null,
      hasWorkspace: false,
      canOpenFiles: false,
    }),
    hasThread: false,
  };
}
