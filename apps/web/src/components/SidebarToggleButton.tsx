import { SidebarTrigger } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface SidebarToggleButtonProps {
  className?: string;
  shortcutLabel?: string | null;
}

export function SidebarToggleButton({ className, shortcutLabel = null }: SidebarToggleButtonProps) {
  const tooltipLabel = shortcutLabel ? `Toggle sidebar (${shortcutLabel})` : "Toggle sidebar";

  return (
    <Tooltip>
      <TooltipTrigger
        render={<SidebarTrigger aria-label="Toggle sidebar" className={className} />}
      />
      <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
    </Tooltip>
  );
}
