import { BoxIcon, PlusIcon } from "lucide-react";

import { SidebarMenuButton } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { openNewSandboxDialog } from "./NewSandboxDialog";
import { useOffersSandboxes } from "./useSandboxes";

/** Beside "Add project" in the sidebar header: a Sandbox is a project with its own machine. */
export function NewSandboxHeaderButton() {
  if (!useOffersSandboxes()) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label="New Sandbox"
            className="relative size-7 shrink-0"
            onClick={() => openNewSandboxDialog()}
          />
        }
      >
        <BoxIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">New Sandbox</TooltipPopup>
    </Tooltip>
  );
}

/** Under "Add project" when the sidebar has no projects yet. */
export function NewSandboxEmptyStateButton() {
  if (!useOffersSandboxes()) return null;
  return (
    <button
      type="button"
      onClick={() => openNewSandboxDialog()}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
    >
      <PlusIcon className="-mx-0.5 size-3" />
      New Sandbox
    </button>
  );
}
