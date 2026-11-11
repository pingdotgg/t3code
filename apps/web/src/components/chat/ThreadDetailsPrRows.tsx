import { pipe } from "effect/Function";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type { EnvironmentId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  pullRequestListLines,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useProjects } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { linkedPullRequestSnapshotStatus, prStatusIndicator } from "../ThreadStatusIndicators";

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

function useStopWatchingPullRequest(threadRef: ScopedThreadRef) {
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  return (link: ThreadPullRequestLink | null) =>
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
}

function PrRowsWithMore({
  environmentId,
  links,
  currentLink,
  currentRow,
  onOpenLink,
  onActed,
  stopWatching,
}: {
  environmentId: EnvironmentId;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  currentRow: ReactNode;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
  onActed?: (() => void) | undefined;
  stopWatching: ReturnType<typeof useStopWatchingPullRequest>;
}) {
  const [expanded, setExpanded] = useState(false);
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
              environmentId={environmentId}
              link={link}
              onOpen={(event) => onOpenLink(event, link.url)}
              onActed={onActed}
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
        {/* Chevrons, not plus and minus: the plus already means "add" in this card. */}
        {expanded ? (
          <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
        )}
        {expanded ? "Show less" : `Show ${rest.length} more`}
      </ThreadDetailsControl>
    </>
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
  const stopWatching = useStopWatchingPullRequest(threadRef);
  return (
    <PrRowsWithMore
      environmentId={row.environmentId}
      links={links}
      currentLink={currentLink}
      currentRow={<ThreadDetailsPrRow {...row} onStopWatching={stopWatching(currentLink)} />}
      onOpenLink={onOpenLink}
      onActed={row.onActed}
      stopWatching={stopWatching}
    />
  );
}

/** The thread's linked pull requests for a workspace with no branch to hang them on. */
export function ThreadDetailsLinkedPrRows({
  threadRef,
  links,
  currentLink,
}: {
  threadRef: ScopedThreadRef;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink;
}) {
  const stopWatching = useStopWatchingPullRequest(threadRef);
  const openPrLink = useOpenPrLink(threadRef);
  return (
    <PrRowsWithMore
      environmentId={threadRef.environmentId}
      links={links}
      currentLink={currentLink}
      currentRow={
        <ThreadDetailsPrLinkRow
          environmentId={threadRef.environmentId}
          link={currentLink}
          onOpen={(event) => openPrLink(event, currentLink.url)}
          onStopWatching={stopWatching(currentLink)}
        />
      }
      onOpenLink={openPrLink}
      stopWatching={stopWatching}
    />
  );
}
