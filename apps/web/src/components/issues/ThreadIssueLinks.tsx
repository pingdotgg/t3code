import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleDotIcon, MessageSquarePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { issueLinkEnvironment } from "~/state/issueLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ISSUE_LINK_SOURCE_LABELS, parseIssueReferenceInput } from "./issueLinks.logic";
import { useStartThreadFromIssue } from "./useStartThreadFromIssue";
import { useThreadIssueLinks } from "./useThreadIssueLinks";

function IssueRow({
  link,
  startDisabledReason,
  onOpen,
  onStart,
  onUnlink,
}: {
  link: ThreadIssueLink;
  startDisabledReason: string | null;
  onOpen: (link: ThreadIssueLink) => void;
  onStart: (link: ThreadIssueLink) => void;
  onUnlink: (link: ThreadIssueLink) => void;
}) {
  return (
    <div className="group/issue-row flex h-7 items-center gap-2 rounded-md px-2 hover:bg-accent/60">
      <CircleDotIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Open ${link.repository}#${link.number} in Issues`}
              className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-xs"
              onClick={() => onOpen(link)}
            />
          }
        >
          <span className="font-mono">#{link.number}</span>
          <span className="truncate text-muted-foreground">{link.repository}</span>
        </TooltipTrigger>
        <TooltipPopup>
          {link.sources.map((source) => ISSUE_LINK_SOURCE_LABELS[source]).join(" · ")}
        </TooltipPopup>
      </Tooltip>
      <span className="flex opacity-0 group-hover/issue-row:opacity-100 has-[:focus-visible]:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Start another thread from #${link.number}`}
                disabled={startDisabledReason !== null}
                onClick={() => onStart(link)}
              />
            }
          >
            <MessageSquarePlusIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {startDisabledReason ?? `Start another thread from #${link.number}`}
          </TooltipPopup>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-micro"
          aria-label={`Unlink #${link.number} from thread`}
          onClick={() => onUnlink(link)}
        >
          <XIcon />
        </Button>
      </span>
    </div>
  );
}

/** The thread's linked GitHub Issues, above its pull requests, each removable. */
export function ThreadIssueLinks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { links, error } = useThreadIssueLinks(threadRef);
  const link = useAtomCommand(issueLinkEnvironment.link, { reportFailure: true });
  const unlink = useAtomCommand(issueLinkEnvironment.unlink, { reportFailure: true });
  const startThread = useStartThreadFromIssue();
  const navigate = useNavigate();
  // The Issues page opens with this Issue's side panel, read through this thread's server.
  const openIssue = (issue: ThreadIssueLink) =>
    void navigate({
      to: "/pull-requests",
      search: {
        ...readPullRequestListPreferences(),
        view: "issues",
        issue: issue.url,
        selectedEnvironmentId: threadRef.environmentId,
      },
    });
  // Null while the link field is closed.
  const [reference, setReference] = useState<string | null>(null);
  const target = reference === null ? null : parseIssueReferenceInput(reference);

  const submit = async () => {
    if (target === null) return;
    const result = await link({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, target, source: "manual" },
    });
    if (result._tag === "Success") setReference(null);
  };
  const handleUnlink = (issue: ThreadIssueLink) => {
    void unlink({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: issue.host,
        repository: issue.repository,
        number: issue.number,
      },
    });
  };

  return (
    <section className="flex flex-col border-b border-border/60 p-1.5">
      <header className="flex h-6 items-center justify-between px-2 text-2xs text-muted-foreground">
        <span>Issues{links.length > 0 ? ` · ${links.length}` : ""}</span>
        {reference === null ? (
          <Button size="micro" variant="ghost" onClick={() => setReference("")}>
            <PlusIcon />
            Link
          </Button>
        ) : null}
      </header>
      {links.map((issue) => (
        <IssueRow
          key={`${issue.host}/${issue.repository}#${issue.number}`}
          link={issue}
          startDisabledReason={(() => {
            const target = startThread.resolve(issue);
            return "reason" in target ? target.reason : null;
          })()}
          // Only the link is known here, so the new thread's composer starts with its URL.
          onStart={(link) => void startThread.start({ ...link, title: null, body: null })}
          onOpen={openIssue}
          onUnlink={handleUnlink}
        />
      ))}
      {links.length === 0 && reference === null ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          {error ?? "No linked Issues. Branches named <type>/<number>-<slug> link theirs."}
        </p>
      ) : null}
      {reference !== null ? (
        <form
          className="flex items-center gap-1 px-1 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            size="compact"
            aria-label="Issue URL or number"
            placeholder="#12 or Issue URL"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setReference(null);
            }}
          />
          <Button type="submit" size="compact" variant="outline" disabled={target === null}>
            Link
          </Button>
        </form>
      ) : null}
    </section>
  );
}
