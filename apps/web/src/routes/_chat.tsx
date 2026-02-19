import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Activity, Suspense, lazy, type ReactNode, useEffect } from "react";

import Sidebar from "../components/Sidebar";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DiffWorkerPoolProvider = lazy(() =>
  import("../components/DiffPanel").then((module) => ({
    default: module.DiffWorkerPoolProvider,
  })),
);
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";

const DiffPanelWrapper = (props: { children: ReactNode; sheet: boolean }) => {
  const { state, dispatch } = useStore();
  if (props.sheet) {
    return (
      <Sheet
        open={state.diffOpen}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "CLOSE_DIFF" });
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
    <aside className={state.diffOpen ? undefined : "hidden"} aria-hidden={!state.diffOpen}>
      {props.children}
    </aside>
  );
};

function ChatRouteLayout() {
  const { state } = useStore();
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  const diffLoadingFallback =
    !state.diffOpen || shouldUseDiffSheet ? (
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
      <Activity mode={state.diffOpen ? "visible" : "hidden"}>
        <DiffPanelWrapper sheet={shouldUseDiffSheet}>
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
