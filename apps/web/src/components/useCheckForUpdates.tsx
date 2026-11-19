import { type DesktopBridge, managedUpdatesDenial } from "@t3tools/contracts";
import { summarizeUpdateCheck, type UpdateCheckItem } from "@t3tools/client-runtime/update-check";
import { APP_NAME } from "@t3tools/shared/branding";

import { usePrimaryManagedPolicy } from "../state/managedPolicy";
import { getDesktopUpdateCheckResult } from "./desktopUpdate.logic";
import { useCheckEnvironmentUpdates } from "./ProviderUpdatesAction";
import { stackedThreadToast, toastManager } from "./ui/toast";

const THIS_APP = `${APP_NAME} (this app)`;

async function checkThisApp(
  bridge: DesktopBridge,
  managedDenial: string | undefined,
): Promise<UpdateCheckItem> {
  try {
    return {
      subject: THIS_APP,
      result: getDesktopUpdateCheckResult(await bridge.checkForUpdate(), managedDenial),
    };
  } catch (error) {
    return {
      subject: THIS_APP,
      result: {
        status: "error",
        reason: error instanceof Error ? error.message : "Update check failed.",
      },
    };
  }
}

function showUpdateCheckToast(items: ReadonlyArray<UpdateCheckItem>) {
  const summary = summarizeUpdateCheck(items);
  toastManager.add(
    stackedThreadToast({
      type: summary.tone === "available" ? "info" : summary.tone === "error" ? "error" : "success",
      title: summary.title,
      description: <span className="whitespace-pre-line">{summary.lines.join("\n")}</span>,
    }),
  );
}

/**
 * Checks this desktop app, every connected environment's own server, and every provider.
 * `errorsOnly` suits a caller that already shows what the check finds.
 */
export function useCheckForUpdates() {
  // The desktop updates this machine, whose policy the primary environment reports.
  const updatesDenial = managedUpdatesDenial(usePrimaryManagedPolicy());
  const checkEnvironments = useCheckEnvironmentUpdates();

  return async ({ errorsOnly = false }: { readonly errorsOnly?: boolean } = {}) => {
    const bridge = window.desktopBridge;
    const [local, environments] = await Promise.all([
      bridge ? checkThisApp(bridge, updatesDenial) : null,
      checkEnvironments(),
    ]);
    const items = local === null ? environments : [local, ...environments];
    const reported = errorsOnly ? items.filter(({ result }) => result.status === "error") : items;
    if (!errorsOnly || reported.length > 0) showUpdateCheckToast(reported);
    return items;
  };
}
