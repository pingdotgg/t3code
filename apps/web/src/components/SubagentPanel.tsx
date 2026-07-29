import {
  Bot,
  CheckCircle2,
  Circle,
  CirclePause,
  LoaderCircle,
  Wrench,
  XCircle,
} from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useI18n, type Translate } from "~/i18n";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "~/session-logic";
import {
  deriveSubagentActivity,
  deriveSubagentChildEntries,
  type SubagentProgressStatus,
} from "~/subagentActivity";
import { formatTimestamp } from "~/timestampFormat";

import { ScrollArea } from "./ui/scroll-area";
import { toolActivityHeading } from "./chat/toolActivityPresentation";

function statusLabel(status: SubagentProgressStatus, t: Translate): string {
  return t(`subagent.status.${status}`);
}

function StatusIcon({ status, className }: { status: SubagentProgressStatus; className?: string }) {
  const iconClassName = cn("size-3.5 shrink-0", className);
  switch (status) {
    case "pending":
    case "running":
      return <LoaderCircle className={cn(iconClassName, "animate-spin text-primary")} />;
    case "completed":
      return <CheckCircle2 className={cn(iconClassName, "text-success-foreground")} />;
    case "failed":
      return <XCircle className={cn(iconClassName, "text-destructive")} />;
    case "interrupted":
    case "stopped":
      return <CirclePause className={cn(iconClassName, "text-muted-foreground")} />;
    case "unknown":
      return <Circle className={cn(iconClassName, "text-muted-foreground/60")} />;
  }
}

function MetadataItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] leading-4 text-muted-foreground/65">{label}</div>
      <div className="mt-0.5 truncate text-xs leading-5 text-foreground">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

export const SubagentPanel = memo(function SubagentPanel({
  entry,
  allEntries,
}: {
  entry: WorkLogEntry | null;
  allEntries: ReadonlyArray<WorkLogEntry>;
}) {
  const { t } = useI18n();
  const settings = useClientSettings();
  const activity = useMemo(() => (entry ? deriveSubagentActivity(entry) : null), [entry]);
  const childEntries = useMemo(
    () => (activity ? deriveSubagentChildEntries(activity, allEntries) : []),
    [activity, allEntries],
  );

  if (!activity) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("subagent.unavailable")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Bot className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-medium text-foreground">{activity.title}</h2>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground">
                <StatusIcon status={activity.status} className="size-3" />
                {statusLabel(activity.status, t)}
              </span>
            </div>
            {activity.role ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{activity.role}</div>
            ) : null}
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          <section className="grid grid-cols-2 gap-x-4 gap-y-3">
            {activity.operation ? (
              <MetadataItem label={t("subagent.operation")}>{activity.operation}</MetadataItem>
            ) : null}
            <MetadataItem label={t("subagent.started")}>
              {formatTimestamp(activity.startedAt, settings.timestampFormat)}
            </MetadataItem>
            {activity.model ? (
              <MetadataItem label={t("subagent.model")}>{activity.model}</MetadataItem>
            ) : null}
            {activity.reasoningEffort ? (
              <MetadataItem label={t("subagent.reasoningEffort")}>
                {activity.reasoningEffort}
              </MetadataItem>
            ) : null}
            {activity.endedAt ? (
              <MetadataItem label={t("subagent.finished")}>
                {formatTimestamp(activity.endedAt, settings.timestampFormat)}
              </MetadataItem>
            ) : null}
          </section>

          {activity.prompt ? (
            <section className="flex flex-col gap-2">
              <SectionTitle>{t("subagent.prompt")}</SectionTitle>
              <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85">
                {activity.prompt}
              </p>
            </section>
          ) : null}

          {activity.agents.length > 0 ? (
            <section className="flex flex-col gap-2">
              <SectionTitle>{t("subagent.agents", { count: activity.agents.length })}</SectionTitle>
              <div className="border-y border-border/70">
                {activity.agents.map((agent, index) => (
                  <div
                    key={agent.id}
                    className={cn(
                      "flex min-w-0 items-start gap-2.5 py-2.5",
                      index > 0 && "border-t border-border/60",
                    )}
                  >
                    <StatusIcon status={agent.status} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-medium text-foreground">
                          {agent.label ?? t("subagent.agent")}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {statusLabel(agent.status, t)}
                        </span>
                      </div>
                      <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground/65">
                        {agent.id}
                      </div>
                      {agent.message ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                          {agent.message}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {childEntries.length > 0 ? (
            <section className="flex flex-col gap-2">
              <SectionTitle>{t("subagent.activity", { count: childEntries.length })}</SectionTitle>
              <div className="border-y border-border/70">
                {childEntries.map((child, index) => (
                  <div
                    key={child.id}
                    className={cn(
                      "flex min-w-0 items-start gap-2 py-2",
                      index > 0 && "border-t border-border/60",
                    )}
                  >
                    <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-foreground">
                        {toolActivityHeading(child, t)}
                      </div>
                      {child.detail || child.command ? (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {child.detail ?? child.command}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {activity.result ? (
            <section className="flex flex-col gap-2">
              <SectionTitle>{t("subagent.result")}</SectionTitle>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border/70 pt-2 font-mono text-[11px] leading-5 text-muted-foreground select-text">
                {activity.result}
              </pre>
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});
