import { useAtomValue } from "@effect/atom-react";
import {
  isTerminalSubagentStatus,
  workflowOpeningHeadline,
  type RuntimeSubagent,
  type WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { findRevealRef } from "./markdownFindContext";
import { shouldCollapseUserMessage } from "./MessagesTimeline.logic";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { EnvironmentSubagentAvatar } from "./V2LifecycleRow";

const FOLDED_SCRIPT_MASK = "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

/** The script as a fenced block, so it renders like any other code in the thread. */
function scriptMarkdown(script: string) {
  const longestRun = Math.max(2, ...(script.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}javascript\n${script.trimEnd()}\n${fence}`;
}

/** Opens a workflow coordinator's thread in place of its script: the plan, its agents, then the script. */
export function WorkflowOpeningBlock(props: {
  readonly opening: WorkflowOpening;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { opening } = props;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const headline = workflowOpeningHeadline(opening);
  const phases = opening.group?.phases.filter((phase) => phase.members.length > 0) ?? [];
  const memberRow = (member: RuntimeSubagent) =>
    opening.providerInstanceId === null ? null : (
      <WorkflowMemberRow
        key={member.id}
        member={member}
        environmentId={props.environmentId}
        providerInstanceId={opening.providerInstanceId}
        providers={providers}
        driver={opening.driver ?? undefined}
        onOpenThread={props.onOpenThread}
      />
    );
  return (
    <section
      aria-label={`Workflow started: ${headline.title}`}
      className="flex min-w-0 flex-col gap-3 px-1 py-0.5"
      data-workflow-opening
    >
      <header className="flex min-w-0 items-start gap-2">
        <WorkflowIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-2xs font-medium text-muted-foreground">Workflow started</p>
          <h3 className="truncate text-sm font-medium text-foreground" data-thread-find-text="true">
            {headline.title}
          </h3>
          {headline.description ? (
            <p className="text-xs text-muted-foreground" data-thread-find-text="true">
              {headline.description}
            </p>
          ) : null}
        </div>
        {headline.agents ? (
          <span aria-live="polite" className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {headline.agents}
          </span>
        ) : null}
      </header>
      {phases.map((phase) => (
        <section key={phase.index} aria-label={`${phase.title} phase`}>
          <h4 className="flex items-baseline gap-2 px-2 pb-0.5 text-2xs font-medium text-muted-foreground">
            <span className="min-w-0 truncate" data-thread-find-text="true">
              {phase.title}
            </span>
            <span className="shrink-0 font-normal tabular-nums">
              {phase.settledCount}/{phase.members.length}
            </span>
          </h4>
          <ul className="m-0 list-none p-0">{phase.members.map(memberRow)}</ul>
        </section>
      ))}
      {opening.group && opening.group.unphasedMembers.length > 0 ? (
        <ul className="m-0 list-none p-0">{opening.group.unphasedMembers.map(memberRow)}</ul>
      ) : null}
      <WorkflowScript script={opening.script} />
    </section>
  );
}

/** One member agent, drawn like the timeline's subagent rows; it opens the member's thread. */
function WorkflowMemberRow(props: {
  readonly member: RuntimeSubagent;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { member } = props;
  const threadId = member.childThreadId;
  const failed = member.status === "failed";
  const detail = (
    isTerminalSubagentStatus(member.status)
      ? (member.error ?? member.result ?? member.progress)
      : member.progress
  )
    ?.replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const className =
    "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            threadId === null ? (
              <div aria-description={member.status} className={className} />
            ) : (
              <button
                type="button"
                aria-label={`Open ${member.title}`}
                aria-description={member.status}
                onClick={() => props.onOpenThread(threadId)}
                className={cn(
                  className,
                  "cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                )}
              />
            )
          }
        >
          <EnvironmentSubagentAvatar
            environmentId={props.environmentId}
            providerInstanceId={props.providerInstanceId}
            driver={props.driver}
            status={member.status}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {member.title}
            </span>
            {detail ? (
              <span
                className={cn(
                  "block truncate text-2xs leading-relaxed",
                  failed ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {detail}
              </span>
            ) : null}
          </span>
          {member.startedAt ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <AgentElapsed agent={member} />
            </span>
          ) : null}
          {threadId !== null ? (
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
            />
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup>
          <SubagentTooltipContent
            title={member.title}
            model={member.model}
            providerInstanceId={props.providerInstanceId}
            origin="provider_native"
            provider={props.providers.find(
              (provider) => provider.instanceId === props.providerInstanceId,
            )}
            providers={props.providers}
            driver={props.driver}
            elapsed={<AgentElapsed agent={member} />}
            status={member.status}
            result={member.result ?? member.error}
            progress={member.progress}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}

/** The script as highlighted code, folded like a long message until opened or found. */
function WorkflowScript(props: { readonly script: string }) {
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const canFold = shouldCollapseUserMessage(props.script);
  const folded = canFold && !expanded;
  return (
    <div>
      <div
        ref={revealRef}
        className={cn("relative", folded && "max-h-44 overflow-hidden")}
        data-thread-find-text="true"
        data-thread-find-fold={folded ? "" : undefined}
        style={
          folded
            ? { WebkitMaskImage: FOLDED_SCRIPT_MASK, maskImage: FOLDED_SCRIPT_MASK }
            : undefined
        }
      >
        <ChatMarkdown text={scriptMarkdown(props.script)} cwd={undefined} />
      </div>
      {canFold ? (
        <div className="-ms-1">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full script"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
