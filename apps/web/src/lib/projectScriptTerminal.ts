/**
 * Picks the drawer terminal a project action can reuse: the active idle drawer terminal, else the
 * first idle one, else null. Right-panel terminals are never reused, so one PTY never renders in
 * both the drawer and the panel.
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
