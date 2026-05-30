export function resolveTerminalRouteBootstrap(input: {
  readonly hasThread: boolean;
  readonly hasWorkspaceRoot: boolean;
  readonly hasOpened: boolean;
  readonly requestedTerminalId: string | null;
  readonly currentTerminalId: string;
  readonly runningTerminalId: string | null;
  readonly currentTerminalStatus: "starting" | "running" | "exited" | "error" | "closed";
  /** True once the attach stream has populated scrollback (`buffer` non-empty), not merely metadata. */
  readonly hasCurrentTerminalHydration: boolean;
}):
  | { readonly kind: "idle" }
  | { readonly kind: "redirect"; readonly terminalId: string }
  | { readonly kind: "open" } {
  if (!input.hasThread || !input.hasWorkspaceRoot || input.hasOpened) {
    return { kind: "idle" };
  }

  if (
    input.requestedTerminalId === null &&
    input.runningTerminalId !== null &&
    input.runningTerminalId !== input.currentTerminalId
  ) {
    return { kind: "redirect", terminalId: input.runningTerminalId };
  }

  if (
    (input.currentTerminalStatus === "running" || input.currentTerminalStatus === "starting") &&
    input.hasCurrentTerminalHydration
  ) {
    return { kind: "idle" };
  }

  return { kind: "open" };
}
