import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { DraftId } from "../../composerDraftStore.ts";
import ChatView from "../ChatView.tsx";
import { Sheet, SheetPopup } from "../ui/sheet.tsx";

export type BoardExpandedSheetTarget =
  | {
      readonly kind: "thread";
      readonly threadRef: ScopedThreadRef;
      readonly title: string;
    }
  | {
      readonly kind: "draft";
      readonly draftId: DraftId;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly title: string;
    };

export interface BoardCardExpandedSheetProps {
  readonly target: BoardExpandedSheetTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function BoardCardExpandedSheet(props: BoardCardExpandedSheetProps) {
  const { target, open, onOpenChange } = props;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="bottom"
        variant="inset"
        className="flex h-[96dvh] max-h-[96dvh] min-h-0 flex-col overflow-hidden sm:row-span-2 sm:row-start-1 sm:h-[80dvh] sm:max-h-[80dvh] sm:w-[80vw] sm:max-w-[80vw] sm:place-self-center"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 pe-12">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={target.title}>
            {target.title}
          </p>
          <Button
            size="sm"
            variant="outline"
            render={
              target.kind === "thread" ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: target.threadRef.environmentId,
                    threadId: target.threadRef.threadId,
                  }}
                />
              ) : (
                <Link to="/draft/$draftId" params={{ draftId: target.draftId }} />
              )
            }
          >
            <Maximize2Icon className="size-3.5" />
            Full screen
          </Button>
        </div>
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          {target.kind === "thread" ? (
            <ChatView
              environmentId={target.threadRef.environmentId}
              threadId={target.threadRef.threadId}
              routeKind="server"
            />
          ) : (
            <ChatView
              draftId={target.draftId}
              environmentId={target.environmentId}
              threadId={target.threadId}
              routeKind="draft"
              forceExpandedMobileComposer
            />
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
