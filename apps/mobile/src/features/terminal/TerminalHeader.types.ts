import type { TerminalMenuSession, getTerminalStatusLabel } from "./terminalMenu";

export interface TerminalHeaderProps {
  readonly subtitle: string;
  readonly isEnvironmentReady: boolean;
  readonly fontSize: number;
  readonly terminalId: string;
  readonly sessions: ReadonlyArray<TerminalMenuSession>;
  readonly status: Parameters<typeof getTerminalStatusLabel>[0];
  readonly workspaceRoot: string;
  readonly onCloseTerminal: () => void;
  readonly onDecreaseFontSize: () => void;
  readonly onIncreaseFontSize: () => void;
  readonly onOpenNewTerminal: () => void;
  readonly onSelectTerminal: (terminalId: string) => void;
}
