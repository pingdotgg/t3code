import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { ThreadContextRecord, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, GitBranchIcon, MessagesSquareIcon } from "lucide-react";
import { useGT } from "gt-react";

import { useProject, useThreadShell } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import { ThreadPullRequestsMiniList } from "./ThreadStatusIndicators";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

type ChipProject = NonNullable<ReturnType<typeof useProject>>;

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  projectId?: ProjectId | null;
  copyMarkdown?: string;
  unreadable?: boolean;
}) {
  const gt = useGT();
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const lookup = useEnvironmentQuery(
    shell === null && props.projectId === undefined
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId,
          input: { threadIds: [threadId] },
        })
      : null,
  );
  const metadata = lookup.data?.[threadId];
  const projectId = shell?.projectId ?? props.projectId ?? metadata?.projectId;
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const title = shell?.title?.trim() || metadata?.title.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId }}
                draggable={false}
              />
            }
            aria-label={gt("Thread, {title}", { title })}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <ThreadHoverCardPopup side="top">
        <ThreadChipHoverCard
          title={title}
          project={project}
          shell={shell}
          unreadable={props.unreadable === true}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

function ThreadChipHoverCard(props: {
  title: string;
  project: ChipProject | null;
  shell: EnvironmentThreadShell | null;
  unreadable: boolean;
}) {
  const gt = useGT();
  const { shell } = props;
  const providers = useEnvironmentProviders();
  const instanceId = shell
    ? (shell.runtime?.providerInstanceId ?? shell.modelSelection.instanceId)
    : null;
  const provider =
    shell && instanceId
      ? (providers.get(shell.environmentId)?.find((entry) => entry.instanceId === instanceId) ??
        null)
      : null;
  const model = shell
    ? provider?.models.find((entry) => entry.slug === shell.modelSelection.model)
    : undefined;
  const modelLabel = model
    ? getTriggerDisplayModelName(model, provider?.driver)
    : shell?.modelSelection.model.trim();
  return (
    <ThreadHoverCard
      title={props.title}
      footer={
        shell && shell.pullRequests.length > 0 ? (
          <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
            <ThreadPullRequestsMiniList pullRequests={shell.pullRequests} />
          </div>
        ) : null
      }
    >
      {props.project ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon project={props.project} className="size-3 shrink-0" />
          <div className="min-w-0 truncate text-foreground/75">{props.project.title}</div>
        </div>
      ) : null}
      {shell?.branch ? (
        <div className="flex min-w-0 items-center gap-2">
          <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
          <MiddleTruncate value={shell.branch} className="flex" />
        </div>
      ) : null}
      {provider && modelLabel ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={resolveProviderInstanceDisplayName(provider)}
            iconClassName="size-3 shrink-0 opacity-60"
          />
          <div className="min-w-0 truncate text-foreground/75">{modelLabel}</div>
        </div>
      ) : null}
      {props.unreadable ? (
        <div className="flex min-w-0 items-start gap-2 text-warning">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
          <div className="min-w-0 flex-1 wrap-break-word">
            {gt(
              "On another machine, so this machine's agent can't read it. Remove it or switch back to send.",
            )}
          </div>
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
