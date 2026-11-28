import { lazy, Suspense, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { CircleAlertIcon } from "lucide-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { PANE_BODY_UNDER_HEADER_CLASS } from "../components/PaneNotch";
import { SettingsPaneHeader, SettingsTabNotch } from "../components/settings/SettingsTabNotch";
import { Button } from "../components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../lib/utils";
import type { LayoutPageContent } from "./layoutModel";
import {
  LayoutPageLocationContext,
  layoutPageHref,
  parseLayoutPageLocation,
} from "./pageNavigation";
import { layoutPageTabLabel } from "./PaneTabs";

const PullRequestsPage = lazy(() =>
  import("../components/pullRequest/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);

const IssuesPage = lazy(() =>
  import("../components/issue/IssuesPage").then((module) => ({
    default: module.IssuesPage,
  })),
);

const WorkflowsPage = lazy(() =>
  import("../components/workflows/WorkflowsPage").then((module) => ({
    default: module.WorkflowsPage,
  })),
);

/** A page that failed to render keeps its pane's tab notch, so its tabs stay reachable. */
function LayoutPageFailure({
  kind,
  onRetry,
}: {
  kind: LayoutPageContent["kind"];
  onRetry: () => void;
}) {
  const gt = useGT();
  const { title, Icon } = layoutPageTabLabel(kind, gt);
  return (
    <SidebarInset variant="pane" className="h-full min-h-0 overflow-hidden overscroll-y-none">
      <div className="pane-mobile-chrome flex min-h-0 min-w-0 flex-1 flex-col">
        <SettingsPaneHeader transparent>
          <SettingsTabNotch
            title={title}
            icon={<Icon aria-hidden className="size-3.5 shrink-0 text-foreground" />}
          >
            <h1 className="truncate">{title}</h1>
          </SettingsTabNotch>
        </SettingsPaneHeader>
        <div
          data-surface-reaches-under-header=""
          className={cn("flex min-h-0 flex-1 flex-col", PANE_BODY_UNDER_HEADER_CLASS)}
        >
          {/* The same notice a list page shows when its list fails to load. */}
          <Empty size="compact" role="alert">
            <CircleAlertIcon aria-hidden className="size-5.5 text-dim-foreground" />
            <EmptyHeader>
              <EmptyTitle>{gt("Could not load this page")}</EmptyTitle>
            </EmptyHeader>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="secondary" onClick={onRetry}>
                <RefreshIcon size="sm" />
                <T>Retry</T>
              </Button>
            </div>
          </Empty>
        </div>
      </div>
    </SidebarInset>
  );
}

export function LayoutPageBody({ content }: { content: LayoutPageContent }) {
  const location = parseLayoutPageLocation(content);
  const navigate = useNavigate();
  const gt = useGT();
  const [retryKey, setRetryKey] = useState(0);
  return (
    <LayoutPageLocationContext value={location}>
      <RenderErrorBoundary
        resetKeys={[content.kind, content.href, retryKey]}
        fallback={
          <LayoutPageFailure
            kind={content.kind}
            onRetry={() => setRetryKey((count) => count + 1)}
          />
        }
      >
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner size="md" tone="muted" />
            </div>
          }
        >
          {content.kind === "pull-requests" ? (
            <PullRequestsPage />
          ) : content.kind === "issues" ? (
            <IssuesPage />
          ) : content.kind === "workflows" ? (
            <WorkflowsPage />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Button
                variant="ghost"
                onClick={() => void navigate({ href: layoutPageHref(content) })}
              >
                {content.kind === "settings" ? gt("Open settings") : gt("Open usage")}
              </Button>
            </div>
          )}
        </Suspense>
      </RenderErrorBoundary>
    </LayoutPageLocationContext>
  );
}
