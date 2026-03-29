import type { ProjectId } from "@t3tools/contracts";
import { Suspense, lazy, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { RightPanelTab } from "../diffRouteSearch";
import type { DiffPanelMode } from "./DiffPanelShell";
import { DiffPanelHeaderSkeleton, DiffPanelLoadingState, DiffPanelShell } from "./DiffPanelShell";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

const DiffPanel = lazy(() => import("./DiffPanel"));
const BrowserPanel = lazy(() => import("./BrowserPanel"));

function DiffLoadingFallback({ mode }: { mode: DiffPanelMode }) {
  return (
    <DiffPanelShell mode={mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
}

function BrowserLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <p className="text-sm">Loading browser...</p>
    </div>
  );
}

interface RightPanelTabsProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  mode: DiffPanelMode;
  projectId: ProjectId | null;
  renderDiff: boolean;
  renderBrowser: boolean;
}

export function RightPanelTabs({
  activeTab,
  onTabChange,
  mode,
  projectId,
  renderDiff,
  renderBrowser,
}: RightPanelTabsProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Tab switcher */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <TabButton active={activeTab === "diff"} onClick={() => onTabChange("diff")}>
          Diff
        </TabButton>
        <TabButton active={activeTab === "browser"} onClick={() => onTabChange("browser")}>
          Browser
        </TabButton>
      </div>

      {/* Content */}
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0", activeTab === "diff" ? "block" : "hidden")}>
          {renderDiff ? (
            <DiffWorkerPoolProvider>
              <Suspense fallback={<DiffLoadingFallback mode={mode} />}>
                <DiffPanel mode={mode} />
              </Suspense>
            </DiffWorkerPoolProvider>
          ) : null}
        </div>
        <div className={cn("absolute inset-0", activeTab === "browser" ? "block" : "hidden")}>
          {renderBrowser && projectId ? (
            <Suspense fallback={<BrowserLoadingFallback />}>
              <BrowserPanel projectId={projectId} />
            </Suspense>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
