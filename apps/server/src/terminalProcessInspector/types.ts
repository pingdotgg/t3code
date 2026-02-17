export type TerminalSubprocessChecker = (terminalPid: number) => Promise<boolean>;

export type TerminalWebPortInspector = (port: number) => Promise<boolean>;

export interface TerminalSubprocessActivity {
  hasRunningSubprocess: boolean;
  runningPorts: number[];
}

export type TerminalSubprocessInspector = (
  terminalPid: number,
) => Promise<TerminalSubprocessActivity>;
