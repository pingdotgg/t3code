import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/**
 * Shared confirmation for every user-initiated terminal close (drawer buttons,
 * panel buttons, and the `terminal.close` keybinding). Auto-exit cleanup skips
 * this path and closes directly.
 */
export async function confirmTerminalClose(label: string): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      [`Close terminal "${label}"?`, "This stops the running process and clears its history."].join(
        "\n",
      ),
      { variant: "destructive" },
    );
  } finally {
    pendingConfirmations -= 1;
  }
}
