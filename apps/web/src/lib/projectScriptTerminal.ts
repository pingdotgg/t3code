/**
 * Project actions reuse only an idle drawer terminal (the active one first). Right-panel ids
 * are excluded even when drawer state lists them: reusing one renders a single PTY in both
 * surfaces, and closing the drawer copy kills the panel shell.
 */
export function findReusableProjectScriptTerminal(input: {
  readonly drawerTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalId: string;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
}): string | null {
  const idleDrawerTerminalIds = input.drawerTerminalIds.filter(
    (terminalId) =>
      !input.panelTerminalIds.has(terminalId) && !input.runningTerminalIds.includes(terminalId),
  );
  if (idleDrawerTerminalIds.includes(input.activeTerminalId)) return input.activeTerminalId;
  return idleDrawerTerminalIds[0] ?? null;
}
