/**
 * Reuse an idle terminal only in the requested surface (the active one first).
 * Panel ids can linger in drawer state; keeping ownership separate prevents a single
 * PTY appearing in both surfaces, where closing one copy would kill the other.
 */
export function findReusableProjectScriptTerminal(input: {
  readonly placement?: "drawer" | "right-panel";
  readonly drawerTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalId: string;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
}): string | null {
  const candidates =
    input.placement === "right-panel"
      ? [...input.panelTerminalIds]
      : input.drawerTerminalIds.filter((terminalId) => !input.panelTerminalIds.has(terminalId));
  const idleTerminalIds = candidates.filter(
    (terminalId) => !input.runningTerminalIds.includes(terminalId),
  );
  if (idleTerminalIds.includes(input.activeTerminalId)) return input.activeTerminalId;
  return idleTerminalIds[0] ?? null;
}
