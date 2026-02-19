import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Activity, Suspense, lazy, type ReactNode, useCallback, useMemo } from "react";

import Sidebar from "../components/Sidebar";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { Sheet, SheetPopup } from "../components/ui/sheet";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DiffWorkerPoolProvider = lazy(() =>
  import("../components/DiffPanel").then((module) => ({
    default: module.DiffWorkerPoolProvider,
  })),
);
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

function ChatRouteLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const routeThreadId = typeof params.threadId === "string" ? params.threadId : null;
  const rawSearch = useSearch({ strict: false });
  const diffSearch = useMemo(
    () => parseDiffRouteSearch(rawSearch as Record<string, unknown>),
    [rawSearch],
  );
  const diffOpen = routeThreadId !== null && diffSearch.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const closeDiff = useCallback(() => {
    if (!routeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: routeThreadId },
      search: (previous) => {
        const {
          diff: _diff,
          diffTurnId: _diffTurnId,
          diffFilePath: _diffFilePath,
          ...rest
        } = previous;
        return rest;
      },
    });
  }, [navigate, routeThreadId]);

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
    <div className="flex h-screen overflow-hidden bg-background text-foreground isolate">
      <Sidebar />
      <Outlet />
      <Activity mode={diffOpen ? "visible" : "hidden"}>
        <DiffPanelWrapper sheet={shouldUseDiffSheet} diffOpen={diffOpen} onCloseDiff={closeDiff}>
          <Suspense fallback={diffLoadingFallback}>
            <DiffWorkerPoolProvider>
              <DiffPanel mode={shouldUseDiffSheet ? "sheet" : "inline"} />
            </DiffWorkerPoolProvider>
          </Suspense>
        </DiffPanelWrapper>
      </Activity>
    </div>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
