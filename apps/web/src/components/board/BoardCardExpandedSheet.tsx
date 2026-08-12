import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import ChatView from "../ChatView.tsx";
import { Sheet, SheetPopup } from "../ui/sheet.tsx";

export interface BoardCardExpandedSheetProps {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function BoardCardExpandedSheet(props: BoardCardExpandedSheetProps) {
  const { threadRef, title, open, onOpenChange } = props;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="bottom"
        variant="inset"
        className="flex h-[96dvh] max-h-[96dvh] min-h-0 flex-col overflow-hidden sm:h-[94dvh] sm:max-h-[94dvh]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 pe-12">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </p>
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: threadRef.environmentId,
                  threadId: threadRef.threadId,
                }}
              />
            }
          >
            <Maximize2Icon className="size-3.5" />
            Full screen
          </Button>
        </div>
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
          />
        </div>
      </SheetPopup>
    </Sheet>
  );
}
