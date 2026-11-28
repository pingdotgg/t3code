import { X } from "lucide-react";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";

interface PanelTabCloseButtonProps {
  label: string;
  onClick: () => void;
  tooltip?: string;
}

export function PanelTabCloseButton({ label, onClick, tooltip }: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover/tab:opacity-100 pointer-coarse:opacity-100"
      aria-label={label}
      onClick={onClick}
    >
      <X aria-hidden className="size-3" />
    </button>
  );

  if (!tooltip) return button;

  return <SharedTooltipTrigger render={button} label={tooltip} />;
}
