import { lazy, Suspense, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import type { LayoutPageContent } from "./layoutModel";
import {
  LayoutPageLocationContext,
  layoutPageHref,
  parseLayoutPageLocation,
} from "./pageNavigation";

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

export function LayoutPageBody({ content }: { content: LayoutPageContent }) {
  const location = parseLayoutPageLocation(content);
  const navigate = useNavigate();
  const gt = useGT();
  const [retryKey, setRetryKey] = useState(0);
  const errorFallback = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-body text-muted-foreground">{gt("Couldn’t load this page.")}</p>
      <Button variant="ghost" size="sm" onClick={() => setRetryKey((count) => count + 1)}>
        {gt("Retry")}
      </Button>
    </div>
  );
  return (
    <LayoutPageLocationContext value={location}>
      <RenderErrorBoundary
        resetKeys={[content.kind, content.href, retryKey]}
        fallback={errorFallback}
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
