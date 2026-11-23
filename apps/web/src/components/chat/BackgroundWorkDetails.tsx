import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { T, useGT, useMessages } from "gt-react";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  TerminalIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { useEnvironmentProviders } from "~/state/environments";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { THREAD_DETAILS_PANEL_ROW_TITLE_CLASS } from "./threadDetailsPanelStyles";

const KIND_ICONS = {
  subagent: BotIcon,
  command: TerminalIcon,
  monitor: ActivityIcon,
  background_task: CircleDashedIcon,
} as const;

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const providers = useEnvironmentProviders().get(props.environmentId);
  const presentation = presentPendingBackgroundWork(props.tasks, m);
  const rows = (presentation?.items ?? []).flatMap((presented) => {
    const task = props.tasks.find((candidate) => candidate.taskId === presented.taskId);
    if (task === undefined) return [];
    const itemKey = task.nativeItemId ?? task.taskId;
    const item = props.turnItems.findLast((candidate) =>
      task.itemId === undefined
        ? (candidate.nativeItemRef?.nativeId || candidate.id) === itemKey
        : candidate.id === task.itemId,
    );
    const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
    const commandLabel = command ? commandDisplayText(command) : undefined;
    const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
    return [
      {
        task,
        title: task.description === undefined && commandLabel ? commandLabel : presented.label,
        mono:
          commandLabel !== undefined &&
          (task.description === undefined || presented.label === commandLabel),
        command,
        outputItemId: itemId && streamsOutput && item?.status === "running" ? itemId : undefined,
        outputThreadId: task.sourceThreadId ?? item?.threadId ?? props.threadId,
        activity:
          item?.type === "subagent" ? item.progress?.replace(/\s+/gu, " ").trim() || null : null,
        startedAtMs: item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null,
        provider:
          task.kind === "subagent"
            ? providers?.find((provider) => provider.instanceId === task.providerInstanceId)
            : undefined,
      },
    ];
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<InlineButton />}>
        <T>Details</T>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="lg" padding="none" aria-labelledby={headingId}>
        <ThreadDetailsSection headingId={headingId} title={gt("Background work")} separated={false}>
          <ul className="m-0 list-none p-0">
            {rows.map((row) => {
              const { task } = row;
              const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
              const expandable =
                childThreadId === undefined &&
                (row.command !== undefined || row.outputItemId !== undefined);
              const expanded = expandable && expandedTaskId === task.taskId;
              const status = backgroundWorkHoldsCompletion([task]) ? "waiting" : "running";
              const startedAtMs = row.startedAtMs;
              const ToggleIcon = expanded ? ChevronUpIcon : ChevronDownIcon;
              return (
                <li key={task.taskId} className="group">
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="row"
                    multiline
                    disabled={childThreadId === undefined && !expandable}
                    aria-expanded={expandable ? expanded : undefined}
                    onClick={() => {
                      if (childThreadId !== undefined) {
                        setOpen(false);
                        props.onOpenThread(childThreadId);
                      } else {
                        setExpandedTaskId(expanded ? null : task.taskId);
                      }
                    }}
                  >
                    <ThreadRelationshipIcon
                      driver={row.provider?.driver}
                      provider={row.provider}
                      fallbackIcon={KIND_ICONS[task.kind]}
                      status={status}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          THREAD_DETAILS_PANEL_ROW_TITLE_CLASS,
                          row.mono && "font-mono text-xs",
                        )}
                      >
                        {row.title}
                      </span>
                      {row.activity ? (
                        <span className="mt-1 block truncate text-2xs font-normal text-muted-foreground">
                          {row.activity}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
                      {threadRelationshipStatusLabel(status, m)}
                      {startedAtMs === null ? null : (
                        <>
                          {" · "}
                          <span
                            ref={tickTextContent(
                              (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs), m),
                              true,
                            )}
                          />
                        </>
                      )}
                    </span>
                    {childThreadId !== undefined ? (
                      <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    ) : expandable ? (
                      <ToggleIcon
                        className={cn(
                          "size-3 shrink-0 text-muted-foreground transition-opacity group-hover:opacity-100",
                          !expanded && "opacity-0",
                        )}
                      />
                    ) : null}
                  </ThreadDetailsControl>
                  {expanded ? (
                    <div className="mx-2.5 mt-1 mb-2 space-y-2 font-mono text-xs whitespace-pre-wrap break-words">
                      {row.command ? (
                        <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
                          <ShellCommandBlock command={row.command} />
                        </div>
                      ) : null}
                      {row.outputItemId ? (
                        <CommandOutputPanel
                          environmentId={props.environmentId}
                          threadId={row.outputThreadId}
                          itemId={row.outputItemId}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </ThreadDetailsSection>
      </PopoverPopup>
    </Popover>
  );
}
