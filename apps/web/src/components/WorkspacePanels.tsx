import type { ReactNode } from "react";
import { Sheet, SheetPopup } from "./ui/sheet";
import { cn } from "~/lib/utils";
import { WorkspaceRightSidebar } from "./WorkspaceRightSidebar";

type WorkspaceSideSheetProps = {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

type WorkspaceRightRailProps = {
  children: ReactNode;
  defaultWidth: string;
  minWidth: number;
  onOpenChange?: (open: boolean) => void;
  open: boolean;
  storageKey: string;
};

type WorkspacePanelLayoutProps = {
  bodyClassName?: string;
  children: ReactNode;
};

export function WorkspaceSideSheet({ children, onOpenChange, open }: WorkspaceSideSheetProps) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {children}
      </SheetPopup>
    </Sheet>
  );
}

export function WorkspaceRightRail({
  children,
  defaultWidth,
  minWidth,
  onOpenChange,
  open,
  storageKey,
}: WorkspaceRightRailProps) {
  return (
    <WorkspaceRightSidebar
      defaultWidth={defaultWidth}
      minWidth={minWidth}
      open={open}
      storageKey={storageKey}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {children}
    </WorkspaceRightSidebar>
  );
}

export function WorkspacePanelLayout({ bodyClassName, children }: WorkspacePanelLayoutProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden">
      <div className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
