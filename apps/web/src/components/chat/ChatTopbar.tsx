import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";
import { definePluginComponent } from "~/plugins/features";

function BuiltinChatTopbar({
  desktop = false,
  className,
  ...props
}: ComponentProps<"header"> & { desktop?: boolean }) {
  return (
    <header
      data-chat-header
      className={cn(
        "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        desktop
          ? "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5"
          : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        className,
      )}
      {...props}
    />
  );
}

export const ChatTopbar = definePluginComponent(
  "component:components/chat/ChatTopbar/ChatTopbar",
  BuiltinChatTopbar,
);
