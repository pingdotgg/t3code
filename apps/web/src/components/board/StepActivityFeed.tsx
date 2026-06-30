import type {
  EnvironmentApi,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

const MAX_VISIBLE_ACTIVITIES = 8;
const MAX_TRACKED_ACTIVITIES = 50;

const toneDotClassName: Record<string, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

function appendActivities(
  current: ReadonlyArray<OrchestrationThreadActivity>,
  incoming: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const byId = new Map(current.map((activity) => [activity.id as string, activity]));
  for (const activity of incoming) {
    byId.set(activity.id as string, activity);
  }
  return [...byId.values()].slice(-MAX_TRACKED_ACTIVITIES);
}

export function StepActivityFeed({
  api,
  threadId,
  live,
}: {
  readonly api: EnvironmentApi | null | undefined;
  readonly threadId: ThreadId;
  readonly live: boolean;
}) {
  const [activities, setActivities] = useState<ReadonlyArray<OrchestrationThreadActivity>>([]);

  useEffect(() => {
    if (!api) {
      return;
    }
    setActivities([]);
    return api.orchestration.subscribeThread(
      { threadId },
      (item: OrchestrationThreadStreamItem) => {
        if (item.kind === "snapshot") {
          setActivities((current) => appendActivities(current, item.snapshot.thread.activities));
          return;
        }
        if (item.event.type === "thread.activity-appended") {
          const activity = item.event.payload.activity;
          setActivities((current) => appendActivities(current, [activity]));
        }
      },
    );
  }, [api, threadId]);

  const visible = activities.slice(-MAX_VISIBLE_ACTIVITIES);
  if (visible.length === 0 && !live) {
    return null;
  }

  return (
    <div
      className="mt-2 space-y-1 rounded-md border border-border/60 bg-muted/15 p-2"
      data-testid="step-activity-feed"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {live ? (
          <span aria-hidden className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
        ) : null}
        {live ? "Agent activity" : "Recent agent activity"}
      </div>
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">Waiting for the agent to start…</p>
      ) : (
        <ol className="space-y-0.5">
          {visible.map((activity) => (
            <li key={String(activity.id)} className="flex items-start gap-1.5 text-xs leading-5">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  toneDotClassName[activity.tone] ?? "bg-muted-foreground/60",
                )}
              />
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={activity.summary}
              >
                {activity.summary}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
