import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function DesktopSidebarReopenButton() {
  const { isMobile, open } = useSidebar();

  if (isMobile || open) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            className="hidden shrink-0 md:-ml-3 md:inline-flex md:size-6"
            data-testid="desktop-sidebar-reopen-trigger"
          />
        }
      />
      <TooltipPopup side="bottom">Open sidebar</TooltipPopup>
    </Tooltip>
  );
}
