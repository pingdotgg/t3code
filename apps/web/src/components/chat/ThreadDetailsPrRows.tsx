import { pipe } from "effect/Function";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
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

import { useProjects, useQuietThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { MorphIcon } from "~/components/MorphIcon";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import {
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
  useThreadDisplayedPullRequest,
} from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  onOpen,
  onActed,
  onStopWatching,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
  onStopWatching?: (() => void) | undefined;
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
      onStopWatching={onStopWatching}
      {...(onActed ? { onActed } : {})}
    />
  );
}

function ThreadDetailsPrRows({
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
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const stopWatching = (link: ThreadPullRequestLink | null) =>
    link?.watch === undefined
      ? undefined
      : () =>
          void watch({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              host: link.host,
              repository: link.repository,
              number: link.number,
              watching: false,
            },
          });
  const currentRow = <ThreadDetailsPrRow {...row} onStopWatching={stopWatching(currentLink)} />;
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
              onStopWatching={stopWatching(link)}
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

/** Linked pull requests need no repository; only the branch's own pull request comes from git. */
export function ThreadDetailsThreadPrRows({
  threadRef,
  project,
  branchPr = null,
  branchSourceControlProvider,
  onActed,
}: {
  threadRef: ScopedThreadRef;
  project: EnvironmentProject | null;
  branchPr?: VcsStatusResult["pr"];
  branchSourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  onActed?: () => void;
}) {
  const thread = useQuietThreadShell(threadRef);
  const displayed = useThreadDisplayedPullRequest(
    threadRef.environmentId,
    thread,
    branchPr,
    branchSourceControlProvider,
  );
  const openPrLink = useOpenPrLink(threadRef);
  const { currentLink, pr, number, url } = displayed;
  if (number === undefined || url === undefined) return null;
  return (
    <ThreadDetailsPrRows
      threadRef={threadRef}
      links={thread?.pullRequests ?? []}
      currentLink={currentLink}
      onOpenLink={openPrLink}
      environmentId={threadRef.environmentId}
      pr={pr}
      number={number}
      reference={currentLink}
      status={displayed.status}
      project={project}
      label={`#${number}${pr?.title.trim() ? `: ${pr.title}` : ""}`}
      openAriaLabel={url}
      onOpen={(event) => openPrLink(event, url)}
      {...(onActed ? { onActed } : {})}
    />
  );
}
