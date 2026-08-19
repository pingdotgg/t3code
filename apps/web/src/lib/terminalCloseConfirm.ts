import { readLocalApi } from "~/localApi";

/**
 * Shared confirmation for every user-initiated terminal close (drawer buttons,
 * panel buttons, and the `terminal.close` keybinding). Auto-exit cleanup skips
 * this path and closes directly.
 */
export async function confirmTerminalClose(label: string): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  return localApi.dialogs.confirm(
    [`Close terminal "${label}"?`, "This stops the running process and clears its history."].join(
      "\n",
    ),
    { variant: "destructive" },
  );
}
