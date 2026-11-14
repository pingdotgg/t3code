import { toServerClock } from "@t3tools/client-runtime/clock";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "~/lib/utils";
import type { SidebarThreadSummary } from "../../types";
import {
  resolveWorkingStartedAt,
  type SidebarThreadStatus,
  type SidebarTopStatus,
  type SidebarTopStatusIcon,
} from "../Sidebar.logic";

const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const satisfies Record<SidebarTopStatusIcon, unknown>;

export function TopStatusIcon(props: { icon: SidebarTopStatusIcon; className: string }) {
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}

function WorkingDuration(props: { environmentId: EnvironmentId; startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel environmentId={props.environmentId} startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { environmentId: EnvironmentId; startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">
      {formatWorkingDurationLabel(toServerClock(props.environmentId, nowMs) - props.startedMs)}
    </span>
  );
}

/** The thread card's status: icon, label and, while it runs, how long. */
export function ThreadTopStatusLabel(props: {
  topStatus: SidebarTopStatus;
  status: SidebarThreadStatus;
  thread: Pick<SidebarThreadSummary, "environmentId" | "latestRun" | "runtime">;
}) {
  const { topStatus, status, thread } = props;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", topStatus.className)}>
      <TopStatusIcon icon={topStatus.icon} className="size-4" />
      {/* Not a live region: BackgroundThreadAnnouncer and the open thread's timeline speak
        status changes, and a collapsed sidebar is inert. */}
      {topStatus.label}
      {status === "preparing" || status === "working" ? (
        <span aria-hidden>
          <WorkingDuration
            environmentId={thread.environmentId}
            startedAt={resolveWorkingStartedAt(thread)}
          />
        </span>
      ) : status === "waiting" ? (
        <span aria-hidden>
          <WorkingDuration
            environmentId={thread.environmentId}
            startedAt={thread.latestRun?.completedAt ?? null}
          />
        </span>
      ) : null}
    </span>
  );
}
