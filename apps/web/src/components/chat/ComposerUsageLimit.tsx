import { useEffect, useState } from "react";
import { HourglassIcon, TimerResetIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { UsageLimitCountdown } from "./UsageLimitCountdown";

/**
 * The composer card for a usage-limit failure. The unavailable state stays
 * visible the whole window; the action toggles auto-resume on and back off
 * without ever hiding the notice. Auto-resume here mirrors the server's own
 * sweep — both dispatch an ordinary turn when the window passes.
 */
export function usageLimitBannerItem(input: {
  readonly threadId: string;
  readonly resetsAt: string;
  readonly autoResumeArmed: boolean;
  readonly onArmAutoResume: () => void;
  readonly onCancelAutoResume: () => void;
}): ComposerBannerStackItem {
  const { threadId, resetsAt, autoResumeArmed, onArmAutoResume, onCancelAutoResume } = input;
  // Track whether the window has passed so the arm action can't fire once
  // the server would reject it; the countdown flips its label at the same
  // moment, and a re-render every 30s is enough to catch the flip.
  const [windowPassed, setWindowPassed] = useState(() => Date.now() >= Date.parse(resetsAt));
  useEffect(() => {
    if (windowPassed) return;
    const interval = window.setInterval(() => {
      if (Date.now() >= Date.parse(resetsAt)) {
        setWindowPassed(true);
      }
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [windowPassed, resetsAt]);
  const armed = autoResumeArmed && !windowPassed;
  return {
    id: `thread-usage-limit:${threadId}`,
    variant: "warning",
    priority: "urgent",
    icon: armed ? <TimerResetIcon /> : <HourglassIcon />,
    title: (
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0">You've used all your plan usage</span>
        <span className="text-muted-foreground">
          · <UsageLimitCountdown resetsAt={resetsAt} />
        </span>
      </span>
    ),
    description: armed
      ? "This thread restarts on its own when the window resets."
      : "Tokens return when the window resets. You can also keep working on another plan.",
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onClick={armed ? onCancelAutoResume : onArmAutoResume}
        disabled={windowPassed && !autoResumeArmed}
      >
        {armed ? "Auto-resume on — cancel" : "Continue when tokens return"}
      </Button>
    ),
  };
}
