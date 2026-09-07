import type {
  useThreadTerminalActions,
  useThreadTerminalSessionState,
} from "./useThreadTerminalActions";

type Actions = Pick<
  ReturnType<typeof useThreadTerminalActions>,
  | "toggleTerminalVisibility"
  | "setTerminalOpen"
  | "splitTerminal"
  | "requestCloseTerminal"
  | "createNewTerminal"
>;

/** Called after keybinding resolution so inline and dedicated terminals consume the same commands. */
export function handleThreadTerminalShortcut(
  command: string,
  event: { preventDefault: () => void; stopPropagation: () => void },
  terminalUiState: ReturnType<typeof useThreadTerminalSessionState>["terminalUiState"],
  actions: Actions,
  panel?: {
    split: (direction?: "horizontal" | "vertical") => void;
    newTerminal: () => void;
    close: (() => void) | undefined;
  },
): boolean {
  if (
    ![
      "terminal.toggle",
      "terminal.split",
      "terminal.splitVertical",
      "terminal.close",
      "terminal.new",
    ].includes(command)
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  if (command === "terminal.toggle") actions.toggleTerminalVisibility();
  else if (command === "terminal.close") {
    if (panel?.close) panel.close();
    else if (terminalUiState.terminalOpen)
      actions.requestCloseTerminal(terminalUiState.activeTerminalId);
  } else if (command === "terminal.new") {
    if (panel) panel.newTerminal();
    else {
      if (!terminalUiState.terminalOpen) actions.setTerminalOpen(true);
      actions.createNewTerminal();
    }
  } else {
    const direction = command === "terminal.splitVertical" ? "vertical" : "horizontal";
    if (panel) panel.split(direction);
    else {
      if (!terminalUiState.terminalOpen) actions.setTerminalOpen(true);
      actions.splitTerminal(direction);
    }
  }
  return true;
}
