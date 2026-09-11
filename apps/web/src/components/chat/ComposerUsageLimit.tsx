import { useEffect, useState } from "react";
import { HourglassIcon, TimerResetIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { UsageLimitCountdown } from "./UsageLimitCountdown";

/**
 * The toggle for the usage-limit card. The unavailable state stays visible the
 * whole window; the action toggles auto-resume on and back off. Auto-resume
 * here mirrors the server's own sweep — both dispatch an ordinary turn when
 * the window passes. The window tracking lives in this component (not in the
 * `usageLimitBannerItem` factory) so hooks stay tied to a stable element and
 * ChatView's hook order is unaffected by the banner appearing or disappearing.
 */
function UsageLimitAutoResumeAction(input: {
  readonly resetsAt: string;
  readonly autoResumeArmed: boolean;
  readonly onArmAutoResume: () => void;
  readonly onCancelAutoResume: () => void;
}) {
  const { resetsAt, autoResumeArmed, onArmAutoResume, onCancelAutoResume } = input;
  // Track whether the window has passed so the arm action can't fire once the
  // server would reject it; the countdown flips its label at the same moment,
  // and a re-render every 30s is enough to catch the flip. Re-syncing whenever
  // a new window arrives keeps a passed window from disabling the next one.
  const [windowPassed, setWindowPassed] = useState(() => Date.now() >= Date.parse(resetsAt));
  useEffect(() => {
    setWindowPassed(Date.now() >= Date.parse(resetsAt));
    const interval = window.setInterval(() => {
      setWindowPassed(Date.now() >= Date.parse(resetsAt));
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [resetsAt]);
  const armed = autoResumeArmed && !windowPassed;
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={armed ? onCancelAutoResume : onArmAutoResume}
      disabled={windowPassed && !autoResumeArmed}
    >
      {armed ? "Auto-resume on — cancel" : "Continue when tokens return"}
    </Button>
  );
}

export function usageLimitBannerItem(input: {
  readonly threadId: string;
  readonly resetsAt: string;
  readonly autoResumeArmed: boolean;
  readonly onArmAutoResume: () => void;
  readonly onCancelAutoResume: () => void;
}): ComposerBannerStackItem {
  const { threadId, resetsAt, autoResumeArmed, onArmAutoResume, onCancelAutoResume } = input;
  return {
    id: `thread-usage-limit:${threadId}`,
    variant: "warning",
    priority: "urgent",
    icon: autoResumeArmed ? <TimerResetIcon /> : <HourglassIcon />,
    title: (
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0">You've used all your plan usage</span>
        <span className="text-muted-foreground">
          · <UsageLimitCountdown resetsAt={resetsAt} />
        </span>
      </span>
    ),
    description: autoResumeArmed
      ? "This thread restarts on its own when the window resets."
      : "Tokens return when the window resets. You can also keep working on another plan.",
    actions: (
      <UsageLimitAutoResumeAction
        resetsAt={resetsAt}
        autoResumeArmed={autoResumeArmed}
        onArmAutoResume={onArmAutoResume}
        onCancelAutoResume={onCancelAutoResume}
      />
    ),
  };
}
