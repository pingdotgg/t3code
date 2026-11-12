import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ThreadId,
  type ThreadSpecialist,
  type ThreadSpecialistMcpServer,
  specialistMcpServerEntries,
  withoutSpecialistMcpServer,
  withoutSpecialistSkill,
} from "@t3tools/contracts";
import { BookOpenIcon, PlugIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useThreadProjection } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

interface ThreadSpecialistLoadoutPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const roleSource = (specialist: ThreadSpecialist) => `From role · @${specialist.key}`;

const mcpSourceDetail = (server: ThreadSpecialistMcpServer) =>
  server.type === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ");

/** Role-scoped skills and MCP from the durable specialist binding. Hidden while unbound or empty. */
export function ThreadSpecialistLoadoutPanel(props: ThreadSpecialistLoadoutPanelProps) {
  const projection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const specialist = projection?.projection.thread.specialist;
  const skills = specialist?.skills ?? [];
  const mcpEntries = specialistMcpServerEntries(specialist);
  const setSpecialist = useOrchestrationCommand(threadEnvironment.setSpecialist, {
    label: "thread role loadout",
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (specialist === undefined || (skills.length === 0 && mcpEntries.length === 0)) {
    return null;
  }

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const patch = async (next: ThreadSpecialist, busy: string) => {
    if (busyKey !== null) return;
    setBusyKey(busy);
    const result = await setSpecialist({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, specialist: next },
    });
    setBusyKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update role tools", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-role-heading" title="Role tools">
      <ul className="m-0 list-none p-0">
        {skills.map((skill) => {
          const busy = `skill:${skill}`;
          return (
            <LoadoutRow
              key={busy}
              icon={<BookOpenIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
              title={skill}
              source={roleSource(specialist)}
              detail="Skill attached to this specialist role"
              removeLabel={`Remove skill ${skill}`}
              busy={busyKey === busy}
              onRemove={() => void patch(withoutSpecialistSkill(specialist, skill), busy)}
            />
          );
        })}
        {mcpEntries.map(([name, server]) => {
          const busy = `mcp:${name}`;
          const detail = mcpSourceDetail(server);
          return (
            <LoadoutRow
              key={busy}
              icon={<PlugIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
              title={name}
              source={`${roleSource(specialist)} · ${server.type}`}
              detail={detail}
              removeLabel={`Remove MCP server ${name}`}
              busy={busyKey === busy}
              onRemove={() => void patch(withoutSpecialistMcpServer(specialist, name), busy)}
            />
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}

function LoadoutRow(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly source: string;
  readonly detail: string;
  readonly removeLabel: string;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) {
  return (
    <li className="group relative flex items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={<ThreadDetailsControl size="sm" variant="ghost" part="row" multiline />}
        >
          {props.icon}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 pe-6">
            <span className="truncate text-sm font-medium leading-4 text-foreground/85">
              {props.title}
            </span>
            <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
              {props.source}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">{props.detail}</TooltipPopup>
      </Tooltip>
      <div
        className={cn(
          "absolute right-1 top-1/2 z-10 -translate-y-1/2 opacity-0",
          "group-hover:opacity-100 group-focus-within:opacity-100",
          "pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                tone="destructive"
                aria-label={props.removeLabel}
                disabled={props.busy}
                onClick={props.onRemove}
              />
            }
          >
            <XIcon aria-hidden className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="left">Remove from role</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}
