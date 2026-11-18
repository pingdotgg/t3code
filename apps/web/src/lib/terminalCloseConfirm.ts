import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close action is waiting on settings or user confirmation. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    let shouldConfirm = true;
    try {
      await ensureClientSettingsHydrated();
      shouldConfirm = getClientSettings().confirmTerminalClose;
    } catch {
      // If saved settings cannot be read, keep the destructive confirmation.
    }
    if (!shouldConfirm) return true;
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            `Close terminal "${labels[0]}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${labels.length} terminals?`,
            `This stops their running processes and clears their histories: ${labels
              .map((label) => `"${label}"`)
              .join(", ")}.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
