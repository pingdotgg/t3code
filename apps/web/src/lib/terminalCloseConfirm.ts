import { translateDynamic } from "../i18nCore";
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
            translateDynamic("terminal:close.confirmOne", { label: labels[0] }),
            translateDynamic("terminal:close.confirmOneDetail"),
          ].join("\n")
        : [
            translateDynamic("terminal:close.confirmMany", { count: labels.length }),
            translateDynamic("terminal:close.confirmManyDetail", {
              labels: labels.map((label) => `"${label}"`).join(", "),
            }),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
