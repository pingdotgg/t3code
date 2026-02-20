import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect } from "react";

import ChatView from "../components/ChatView";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";

const DiffPanelWrapper = (props: {
  children: ReactNode;
  sheet: boolean;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  if (props.sheet) {
    return (
      <Sheet
        open={props.diffOpen}
        onOpenChange={(open) => {
          if (!open) {
            props.onCloseDiff();
          }
        }}
      >
        <SheetPopup
          side="right"
          showCloseButton={false}
          keepMounted
          className="w-[min(88vw,820px)] max-w-[820px] p-0"
        >
          {props.children}
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <aside className={props.diffOpen ? undefined : "hidden"} aria-hidden={!props.diffOpen}>
      {props.children}
    </aside>
  );
};

function ChatThreadRouteView() {
  const { state } = useStore();
  const navigate = useNavigate();
  const { threadId } = Route.useParams();
  const search = Route.useSearch();
  const threadExists = threadId ? state.threads.some((thread) => thread.id === threadId) : false;
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        return stripDiffSearchParams(previous);
      },
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (!threadId) {
      void navigate({ to: "/", replace: true });
      return;
    }

    if (!state.threadsHydrated) {
      return;
    }

    if (!threadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, state.threadsHydrated, threadExists, threadId]);

  if (!threadId || !state.threadsHydrated || !threadExists) {
    return null;
  }

  const diffLoadingFallback =
    !diffOpen || shouldUseDiffSheet ? (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        Loading diff viewer...
      </div>
    ) : (
      <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
        Loading diff viewer...
      </aside>
    );

  return (
    <>
      <ChatView threadId={threadId} />
      <DiffPanelWrapper sheet={shouldUseDiffSheet} diffOpen={diffOpen} onCloseDiff={closeDiff}>
        <Suspense fallback={diffLoadingFallback}>
          <DiffPanel mode={shouldUseDiffSheet ? "sheet" : "inline"} />
        </Suspense>
      </DiffPanelWrapper>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
