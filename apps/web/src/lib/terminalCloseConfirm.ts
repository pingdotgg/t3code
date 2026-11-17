import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

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
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            m(msg('Close terminal "{label}"?', { label: labels[0] })),
            m(msg("This stops the running process and clears its history.")),
          ].join("\n")
        : [
            m(
              msg("Close {count, plural, one {{count} terminal} other {{count} terminals}}?", {
                count: labels.length,
              }),
            ),
            m(
              msg("This stops their running processes and clears their histories: {labels}.", {
                labels: labels.map((label) => `"${label}"`).join(", "),
              }),
            ),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
