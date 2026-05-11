import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

type DesktopSidebarReopenButtonProps = {
  className?: string;
};

export function DesktopSidebarReopenButton({ className }: DesktopSidebarReopenButtonProps) {
  const { isMobile, open } = useSidebar();

  if (isMobile || open) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            className={cn("hidden shrink-0 md:-ml-3 md:inline-flex md:size-6", className)}
            data-testid="desktop-sidebar-reopen-trigger"
          />
        }
      />
      <TooltipPopup side="bottom">Open sidebar</TooltipPopup>
    </Tooltip>
  );
}
