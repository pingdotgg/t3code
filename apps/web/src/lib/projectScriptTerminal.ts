/** Project actions reuse only an idle right-panel terminal (the active one first). */
export function findReusableProjectScriptTerminal(input: {
  readonly panelTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalId: string;
  readonly runningTerminalIds: ReadonlyArray<string>;
}): string | null {
  const idleTerminalIds = input.panelTerminalIds.filter(
    (terminalId) => !input.runningTerminalIds.includes(terminalId),
  );
  if (idleTerminalIds.includes(input.activeTerminalId)) return input.activeTerminalId;
  return idleTerminalIds[0] ?? null;
}
