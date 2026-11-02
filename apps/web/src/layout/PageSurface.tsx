import { lazy, Suspense } from "react";
import { useNavigate } from "@tanstack/react-router";

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

export function LayoutPageBody({ content }: { content: LayoutPageContent }) {
  const location = parseLayoutPageLocation(content);
  const navigate = useNavigate();
  return (
    <LayoutPageLocationContext value={location}>
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="md" tone="muted" />
          </div>
        }
      >
        {content.kind === "pull-requests" ? (
          <PullRequestsPage />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Button
              variant="ghost"
              onClick={() => void navigate({ href: layoutPageHref(content) })}
            >
              {content.kind === "settings" ? "Open settings" : "Open usage"}
            </Button>
          </div>
        )}
      </Suspense>
    </LayoutPageLocationContext>
  );
}
