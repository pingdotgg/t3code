import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { IssueDetail } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { CircleCheck, CircleDot, CircleSlash, MessageSquare, User } from "lucide-react";
import { useMemo } from "react";

import { openInBrowser } from "../browser/browserTabs";
import type { Ticket } from "../domain/ticket";
import { issueEnvironment } from "../state/issues";
import { usePrContext } from "../state/prStatus";
import { PopMenu } from "../ui/PopMenu";
import { ticketIssueRef } from "./issueLinks";

const NO_ISSUE = Atom.make(AsyncResult.initial<never, never>()).pipe(
  Atom.withLabel("ticket-issue:none"),
);

const chip =
  "inline-flex max-w-full items-center gap-1 rounded border border-line px-1.5 text-[10px] leading-4 text-muted";

/** Open reads green and done reads violet, as pull requests do; a close that was not done reads grey. */
function stateOf(state: IssueDetail["state"]) {
  if (state.category === "open") return { tone: "text-emerald-300", Icon: CircleDot };
  if (state.closeReason !== undefined && state.closeReason !== "completed") {
    return { tone: "text-faint", Icon: CircleSlash };
  }
  return { tone: "text-violet-300", Icon: CircleCheck };
}

export function IssueChip({
  ticket,
  onOpenThread,
}: {
  ticket: Pick<Ticket, "issue">;
  onOpenThread: (threadId: string) => void;
}) {
  const { project } = usePrContext();
  const githubScope = sourceControlClients.issueScope(project.repositoryIdentity);
  const ref = useMemo(
    () => ticketIssueRef(ticket, { projectId: project.id, githubScope }),
    [ticket, project.id, githubScope],
  );
  const result = useAtomValue(
    ref === null
      ? NO_ISSUE
      : issueEnvironment.detail({ environmentId: project.environmentId, input: ref }),
  );
  const detail = AsyncResult.getOrElse(result, () => null);
  const threads = AsyncResult.getOrElse(
    useAtomValue(
      detail === null
        ? NO_ISSUE
        : issueEnvironment.linkedThreads({
            environmentId: project.environmentId,
            input: {
              tracker: detail.tracker,
              host: detail.host,
              scope: detail.scope,
              key: detail.key,
            },
          }),
    ),
    () => null,
  )?.threads.filter((thread) => thread.archivedAt === null);

  if (ticket.issue == null) return null;
  if (detail === null) {
    return (
      <span data-testid="issue-chip" className={chip}>
        <span className="truncate">{ticket.issue.key}</span>
        <span className="text-faint">
          {ref === null || result._tag === "Failure" ? "unavailable" : "…"}
        </span>
      </span>
    );
  }
  const { tone, Icon } = stateOf(detail.state);
  const assignee = detail.assignees[0]?.login ?? null;
  return (
    <span className="contents" onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        data-testid="issue-chip"
        aria-label={`Open ${detail.displayKey} in the browser`}
        onClick={() => openInBrowser(detail.url)}
        className={`${chip} hover:bg-hover hover:text-fg`}
      >
        <Icon className={`size-3 shrink-0 ${tone}`} aria-hidden />
        <span className="font-mono text-fg">{detail.displayKey}</span>
        <span className={`truncate ${tone}`}>{detail.state.name}</span>
        <User className="size-3 shrink-0" aria-hidden />
        <span className="truncate" data-testid="issue-assignee">
          {assignee ?? "Unassigned"}
        </span>
      </button>
      {threads !== undefined && threads.length > 0 && (
        <PopMenu
          label={`Threads linked to ${detail.displayKey}`}
          align="start"
          triggerClass={`${chip} hover:bg-hover hover:text-fg`}
          trigger={
            <>
              <MessageSquare className="size-3" aria-hidden />
              {threads.length}
            </>
          }
          items={threads.map((thread) => ({
            label: thread.title,
            onSelect: () => onOpenThread(thread.id),
          }))}
        />
      )}
    </span>
  );
}
