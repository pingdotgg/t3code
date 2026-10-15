import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type { EnvironmentId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { Minus, Plus } from "lucide";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import { findProjectOnChangeRequestHost, parseChangeRequestUrl } from "~/lib/openPullRequestLink";

import { useProjects } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { pullRequestListLines } from "../pullRequest/pullRequestListLines";
import { MorphIcon } from "~/components/MorphIcon";
import { linkedPullRequestSnapshotStatus, prStatusIndicator } from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import { threadPullRequestLabel } from "./threadPullRequestLabel";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  threadProject,
  onOpen,
  onActed,
  onStopWatching,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  threadProject: EnvironmentProject | null;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
  onStopWatching?: (() => void) | undefined;
}) {
  const projects = useProjects();
  const parsed = parseChangeRequestUrl(link.url);
  const project =
    parsed === null
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed,
        ) ?? null);
  const linked = linkedPullRequestSnapshotStatus(link);
  const pr = linked?.pr ?? null;
  const referenceLabel = threadPullRequestLabel(link, threadProject);
  return (
    <ThreadDetailsPrRow
      environmentId={environmentId}
      pr={pr}
      number={link.number}
      reference={link}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      project={project}
      label={`${referenceLabel}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`}
      referenceLabel={referenceLabel}
      openAriaLabel={link.url}
      onOpen={onOpen}
      onStopWatching={onStopWatching}
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
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  // Only watched links get the eye; the row hides it once the server records the stop.
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
  const referenceLabel =
    currentLink === null ? `#${row.number}` : threadPullRequestLabel(currentLink, row.project);
  const currentRow = (
    <ThreadDetailsPrRow
      {...row}
      label={
        currentLink === null
          ? row.label
          : `${referenceLabel}${row.pr?.title.trim() ? `: ${row.pr.title}` : ""}`
      }
      referenceLabel={referenceLabel}
      onStopWatching={stopWatching(currentLink)}
    />
  );
  const rest =
    currentLink === null
      ? []
      : pullRequestListLines(resolveThreadPullRequestChains(visibleThreadPullRequests(links)))
          .map((line) => line.link)
          .filter((link) => threadPullRequestKeyOf(link) !== threadPullRequestKeyOf(currentLink));
  if (rest.length === 0) return currentRow;

  return (
    <>
      {currentRow}
      {expanded
        ? rest.map((link) => (
            <ThreadDetailsPrLinkRow
              key={threadPullRequestKeyOf(link)}
              environmentId={row.environmentId}
              link={link}
              threadProject={row.project}
              onOpen={(event) => onOpenLink(event, link.url)}
              onActed={row.onActed}
              onStopWatching={stopWatching(link)}
            />
          ))
        : null}
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        part="row"
        tone="muted"
        className="w-full active:scale-100"
      >
        <MorphIcon aria-hidden className="size-4 shrink-0" icon={expanded ? Minus : Plus} />
        {expanded ? "Show less" : `Show ${rest.length} more`}
      </ThreadDetailsControl>
    </>
  );
}
