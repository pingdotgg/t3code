import type { CSSProperties, ReactNode } from "react";
import { useCallback } from "react";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { shouldAcceptWorkspaceSidebarWidth } from "../workspaceSidebarSizing";

type WorkspaceRightSidebarProps = {
  children: ReactNode;
  defaultWidth: string;
  minWidth: number;
  onOpenChange?: (open: boolean) => void;
  open: boolean;
  storageKey: string;
};

export function WorkspaceRightSidebar({
  children,
  defaultWidth,
  minWidth,
  onOpenChange,
  open,
  storageKey,
}: WorkspaceRightSidebarProps) {
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={handleOpenChange}
      persistState={false}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": defaultWidth } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        desktopMode="inline"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth,
          shouldAcceptWidth: shouldAcceptWorkspaceSidebarWidth,
          storageKey,
        }}
      >
        {children}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}
