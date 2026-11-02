/**
 * Project actions reuse only an idle drawer terminal (the active one first). Right-panel ids
 * are excluded even when drawer state lists them: reusing one renders a single PTY in both
 * surfaces, and closing the drawer copy kills the panel shell.
 */
export function findReusableProjectScriptTerminal(input: {
  readonly terminalIds: ReadonlyArray<string>;
  readonly activeTerminalId: string | null;
  readonly runningTerminalIds: ReadonlyArray<string>;
}): string | null {
  const idleTerminalIds = input.terminalIds.filter(
    (terminalId) => !input.runningTerminalIds.includes(terminalId),
  );
  if (input.activeTerminalId !== null && idleTerminalIds.includes(input.activeTerminalId)) {
    return input.activeTerminalId;
  }
  return idleTerminalIds[0] ?? null;
}
