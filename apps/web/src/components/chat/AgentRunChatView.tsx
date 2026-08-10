import { memo, useMemo, useRef } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { TITLEBAR_CONTROL_INSET_CLASS, TITLEBAR_ROW_CLASS } from "../../lib/titlebar";
import { deriveAgentRunTimelineEntries, type AgentRun } from "../../session-logic";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { Badge } from "../ui/badge";
import { SidebarTrigger } from "../ui/sidebar";
import { MessagesTimeline } from "./MessagesTimeline";

export const AgentRunChatView = memo(function AgentRunChatView({
  agentRun,
  environmentId,
  threadId,
  workspaceRoot,
}: {
  agentRun: AgentRun;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspaceRoot: string | undefined;
}) {
  const settings = useSettings();
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  const timelineEntries = useMemo(() => deriveAgentRunTimelineEntries(agentRun), [agentRun]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-chat-background">
      <header
        className={cn(
          "shrink-0 border-b border-border",
          isElectron
            ? // An agent run always fills the window, so its trailing badge always
              // has to clear the Windows overlay controls.
              cn(
                "drag-region flex items-center px-3 sm:px-5",
                TITLEBAR_ROW_CLASS,
                TITLEBAR_CONTROL_INSET_CLASS,
              )
            : "py-2 ps-[calc(env(safe-area-inset-left)+--spacing(3))] pe-[calc(env(safe-area-inset-right)+--spacing(3))] sm:py-3 sm:ps-[calc(env(safe-area-inset-left)+--spacing(5))] sm:pe-[calc(env(safe-area-inset-right)+--spacing(5))]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
          <SidebarTrigger className="no-drag size-7 shrink-0" />
          <h2
            className="min-w-0 shrink truncate font-medium text-foreground"
            style={{ fontSize: "var(--app-chat-font-size)" }}
            title={agentRun.name}
          >
            {agentRun.name}
          </h2>
          <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
            Read only
          </Badge>
        </div>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessagesTimeline
            isWorking={agentRun.status === "running"}
            activeTurnInProgress={false}
            activeTurnId={null}
            activeTurnStartedAt={agentRun.status === "running" ? agentRun.startedAt : null}
            listRef={listRef}
            timelineEntries={timelineEntries}
            completionDividerBeforeEntryId={null}
            completionSummary={null}
            copilotResumeCommand={null}
            turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFF_SUMMARIES}
            routeThreadKey={`agent-run:${threadId}:${agentRun.taskId}`}
            onOpenTurnDiff={() => undefined}
            revertTurnCountByUserMessageId={EMPTY_REVERT_TURN_COUNTS}
            onRevertUserMessage={() => undefined}
            isRevertingCheckpoint={false}
            onImageExpand={() => undefined}
            activeThreadEnvironmentId={environmentId}
            activeThreadId={threadId}
            markdownCwd={workspaceRoot}
            resolvedTheme={resolvedTheme}
            timestampFormat={settings.timestampFormat}
            workspaceRoot={workspaceRoot}
            onIsAtEndChange={() => undefined}
          />
        </div>
      </div>
    </div>
  );
});

const EMPTY_TURN_DIFF_SUMMARIES = new Map();
const EMPTY_REVERT_TURN_COUNTS = new Map();
