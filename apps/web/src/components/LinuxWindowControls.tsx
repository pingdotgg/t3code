import { MinusIcon, SquareIcon, XIcon } from "lucide-react";

import type { DesktopWindowControl } from "@t3tools/contracts";
import { cn } from "~/lib/utils";

import { Button } from "./ui/button";

function LinuxWindowControlButton(props: { action: DesktopWindowControl }) {
  const bridge = window.desktopBridge;

  const onClick = async () => {
    switch (props.action) {
      case "minimize":
        await bridge?.minimizeWindow?.();
        return;
      case "maximize":
        await bridge?.toggleMaximizeWindow?.();
        return;
      case "close":
        await bridge?.closeWindow?.();
        return;
    }
  };

  return (
    <Button
      aria-label={props.action}
      className={cn(
        "pointer-events-auto [-webkit-app-region:no-drag] text-muted-foreground/80 hover:text-foreground",
        props.action === "close" && "hover:bg-destructive/16 hover:text-destructive-foreground",
      )}
      size="icon-xs"
      variant="ghost"
      onClick={() => {
        void onClick();
      }}
    >
      {props.action === "minimize" ? (
        <MinusIcon className="size-3.5" />
      ) : props.action === "maximize" ? (
        <SquareIcon className="size-3" />
      ) : (
        <XIcon className="size-3.5" />
      )}
    </Button>
  );
}

export function LinuxWindowControls(props: { actions: readonly DesktopWindowControl[] }) {
  if (props.actions.length === 0) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {props.actions.map((action) => (
        <LinuxWindowControlButton key={action} action={action} />
      ))}
    </div>
  );
}
