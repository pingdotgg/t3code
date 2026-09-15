import type { ComponentType, MouseEventHandler, ReactNode } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

interface TerminalActionButtonProps {
  readonly icon?: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly className?: string;
  readonly onClick: () => void;
  readonly onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  readonly children?: ReactNode;
}

export const TerminalActionButton = ({
  icon: Icon,
  label,
  className = "p-1 text-foreground/90 transition-colors hover:bg-accent",
  onClick,
  onMouseDown,
  children,
}: TerminalActionButtonProps) => (
  <Popover>
    <PopoverTrigger
      openOnHover
      render={
        <button
          type="button"
          className={className}
          onClick={onClick}
          onMouseDown={onMouseDown}
          aria-label={label}
        />
      }
    >
      {Icon ? <Icon className="size-3.25" /> : children}
    </PopoverTrigger>
    <PopoverPopup
      tooltipStyle
      side="bottom"
      sideOffset={6}
      align="center"
      className="pointer-events-none select-none"
    >
      {label}
    </PopoverPopup>
  </Popover>
);
