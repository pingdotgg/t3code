import { RefreshCwIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import type { LinearDegradation } from "./linearDegradation";

const COPY: Record<LinearDegradation, string> = {
  rate_limited: "Linear rate limit hit. Showing cached data.",
  unavailable: "Couldn't reach Linear. Showing cached data.",
};

/** Cached-data banner; the page keeps rendering whatever it has underneath it. */
export function LinearBanner({
  degradation,
  onRetry,
  retrying,
}: {
  degradation: LinearDegradation;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Alert variant="warning" data-testid="linear-degraded-banner" data-kind={degradation}>
      <AlertDescription>{COPY[degradation]}</AlertDescription>
      <AlertAction>
        <Button size="compact" variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCwIcon aria-hidden className={retrying ? "animate-spin" : undefined} />
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}
