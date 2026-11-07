import { pipe } from "effect/Function";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  pullRequestListLines,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { ChevronDown, ChevronUp } from "lucide";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";

import { useProjects, useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { MorphIcon } from "~/components/MorphIcon";
import { linkedPullRequestSnapshotStatus, prStatusIndicator } from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  onOpen,
  onActed,
  watch,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
  watch?: ComponentProps<typeof ThreadDetailsPrRow>["watch"];
}) {
  const projects = useProjects();
  const parsed = sourceControlClients.parseChangeRequestUrl(link.url)?.link;
  const project =
    parsed === undefined
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed,
        ) ?? null);
  const linked = linkedPullRequestSnapshotStatus(link);
  const pr = linked?.pr ?? null;
  return (
    <ThreadDetailsPrRow
      environmentId={environmentId}
      pr={pr}
      number={link.number}
      reference={link}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      project={project}
      label={`#${link.number}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`}
      openAriaLabel={link.url}
      onOpen={onOpen}
      watch={watch}
      {...(onActed ? { onActed } : {})}
    />
  );
}

export function ThreadDetailsPrRows({
  threadRef,
  links,
  currentLink,
  onOpenLink,
  ...row
}: ComponentProps<typeof ThreadDetailsPrRow> & {
  threadRef: ScopedThreadRef;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const setWatching = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const thread = useQuietThreadShell(threadRef);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const supportsWatch =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities
      .threadPullRequestWatch === true;
  // The server refuses new watches on settled, archived and subagent threads.
  const canStartWatch =
    supportsWatch &&
    canOperate &&
    thread !== null &&
    thread.archivedAt === null &&
    thread.settledAt === null &&
    thread.settledOverride !== "settled" &&
    thread.lineage.relationshipToParent !== "subagent";
  // A watch that already exists can always be stopped.
  const watchOf = (link: ThreadPullRequestLink | null) => {
    if (link === null) return undefined;
    const watching = link.watch !== undefined;
    if (!watching && !canStartWatch) return undefined;
    return {
      watching,
      onToggle: () =>
        void setWatching({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: !watching,
          },
        }),
    };
  };
  const currentRow = <ThreadDetailsPrRow {...row} watch={watchOf(currentLink)} />;
  const rest =
    currentLink === null
      ? []
      : pipe(visibleThreadPullRequests(links), resolveThreadPullRequestChains, pullRequestListLines)
          .map((line) => line.link)
          .filter((link) => threadPullRequestKeyOf(link) !== threadPullRequestKeyOf(currentLink));
  if (rest.length === 0) return currentRow;

  return (
    <>
      {currentRow}
      {expanded ? (
        <div data-thread-details-pr-list className="flex flex-col">
          {rest.map((link) => (
            <ThreadDetailsPrLinkRow
              key={threadPullRequestKeyOf(link)}
              environmentId={row.environmentId}
              link={link}
              onOpen={(event) => onOpenLink(event, link.url)}
              onActed={row.onActed}
              watch={watchOf(link)}
            />
          ))}
        </div>
      ) : null}
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        part="row"
        tone="muted"
        className="w-full active:scale-100"
      >
        <MorphIcon
          aria-hidden
          className="size-4 shrink-0"
          // Chevrons, not plus and minus: the plus already means "add" in this card.
          icon={expanded ? ChevronUp : ChevronDown}
        />
        {expanded ? "Show less" : `Show ${rest.length} more`}
      </ThreadDetailsControl>
    </>
  );
}
