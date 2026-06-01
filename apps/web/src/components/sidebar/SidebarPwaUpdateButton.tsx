import { RefreshCwIcon } from "lucide-react";

import { isElectron } from "../../env";
import { usePwaServiceWorkerUpdateStore } from "../../pwa/serviceWorkerUpdateState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarPwaUpdateButton() {
  const status = usePwaServiceWorkerUpdateStore((state) => state.status);
  const errorMessage = usePwaServiceWorkerUpdateStore((state) => state.errorMessage);
  const reloadForUpdate = usePwaServiceWorkerUpdateStore((state) => state.reloadForUpdate);

  if (isElectron || status === "idle") {
    return null;
  }

  const updating = status === "updating";
  const title = updating ? "Updating..." : errorMessage ? "Retry update" : "Reload to update";
  const tooltip = errorMessage
    ? `Could not start the update: ${errorMessage}`
    : "Reload Salchi to use the latest web app version.";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-disabled={updating || undefined}
            aria-label={tooltip}
            className={`flex h-7 w-full items-center gap-2 rounded-lg border border-blue-500/80 bg-blue-600 px-2 text-left text-[13px] font-medium text-white shadow-xs shadow-blue-600/20 transition-colors hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-hidden md:text-xs dark:border-blue-400/70 dark:bg-blue-500 dark:hover:bg-blue-400 ${
              updating ? "cursor-wait opacity-85" : "cursor-pointer"
            }`}
            onClick={reloadForUpdate}
          >
            <RefreshCwIcon className={`size-3.5 ${updating ? "animate-spin" : ""}`} />
            <span className="truncate">{title}</span>
          </button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
