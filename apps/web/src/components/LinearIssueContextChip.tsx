import type { LinearIssueContextRecord, LinearStateType } from "@t3tools/contracts";

import { ContextChip, ContextChipLabel } from "./ContextChip";
import ChatMarkdown from "./ChatMarkdown";
import { LinearGlyph, LinearStateIcon } from "./linear/linearIcons";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";

const LINEAR_STATE_TYPES: ReadonlySet<string> = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

function asStateType(value: string): LinearStateType {
  return LINEAR_STATE_TYPES.has(value) ? (value as LinearStateType) : "unstarted";
}

/** "+ 3 sub-issues, 2 comments", or null when the snapshot carries neither. */
function linearIssueExtrasSummary(
  record: Pick<LinearIssueContextRecord, "subIssues" | "comments">,
): string | null {
  const parts = [
    record.subIssues.length > 0
      ? `${record.subIssues.length} sub-issue${record.subIssues.length === 1 ? "" : "s"}`
      : null,
    record.comments.length > 0
      ? `${record.comments.length} comment${record.comments.length === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `+ ${parts.join(", ")}`;
}

function LinearIssuePreview({ record }: { readonly record: LinearIssueContextRecord }) {
  const crumbs = [record.teamName, record.projectName, record.milestoneName].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  const meta = [record.priorityLabel, record.assigneeName].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  const excerpt = record.description.trim().slice(0, 600);
  return (
    <div className="w-96 max-w-full space-y-2 p-3 text-xs">
      <div className="truncate text-2xs text-muted-foreground">{crumbs.join(" › ")}</div>
      <div className="flex items-start gap-1.5">
        <LinearStateIcon type={asStateType(record.stateType)} className="mt-0.5" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            <span className="font-mono text-muted-foreground">{record.identifier}</span>{" "}
            {record.title}
          </div>
          <div className="text-muted-foreground">{[record.stateName, ...meta].join(" · ")}</div>
        </div>
      </div>
      {record.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {record.labels.map((label) => (
            <span
              key={label}
              className="rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}
      {excerpt ? (
        <div className="max-h-32 overflow-hidden text-foreground [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
          <ChatMarkdown text={excerpt} cwd={undefined} />
        </div>
      ) : null}
      {record.subIssues.length > 0 ? (
        <div className="space-y-0.5">
          <div className="text-2xs font-medium text-muted-foreground">
            Sub-issues ({record.subIssues.length})
          </div>
          {record.subIssues.slice(0, 5).map((sub) => (
            <div key={sub.identifier} className="flex items-center gap-1.5">
              <LinearStateIcon type={asStateType(sub.stateType)} />
              <span className="font-mono text-muted-foreground">{sub.identifier}</span>
              <span className="truncate">{sub.title}</span>
            </div>
          ))}
          {record.subIssues.length > 5 ? (
            <div className="text-2xs text-muted-foreground">
              and {record.subIssues.length - 5} more
            </div>
          ) : null}
        </div>
      ) : null}
      {record.comments.length > 0 ? (
        <div className="space-y-0.5">
          <div className="text-2xs font-medium text-muted-foreground">
            Comments ({record.comments.length})
          </div>
          {record.comments.slice(-2).map((comment) => (
            <div key={comment.createdAt + (comment.author ?? "")} className="line-clamp-2">
              <span className="font-medium">{comment.author ?? "Unknown"}</span>{" "}
              <span className="text-muted-foreground">{comment.body.trim()}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="text-2xs text-muted-foreground">
        Snapshot taken when attached; later edits in Linear are not included.
      </div>
    </div>
  );
}

/** Inline chip for an attached Linear issue, with a hover card of what the agent will read. */
export function LinearIssueContextChip(props: {
  record: LinearIssueContextRecord;
  copyMarkdown?: string;
}) {
  const { record } = props;
  const extras = linearIssueExtrasSummary(record);
  return (
    <PreviewCard>
      <PreviewCardTrigger
        delay={200}
        render={
          <ContextChip
            kind="linear-issue"
            tabIndex={0}
            render={<a href={record.url} target="_blank" rel="noreferrer" />}
            aria-label={`Linear issue, ${record.identifier}: ${record.title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            <LinearGlyph className="size-[1em]" />
            <ContextChipLabel>{`${record.identifier} · ${record.title}`}</ContextChipLabel>
            {extras ? (
              <span className="shrink-0 pl-1 font-normal text-muted-foreground">{extras}</span>
            ) : null}
          </ContextChip>
        }
      />
      <PreviewCardPopup side="top" align="start">
        <LinearIssuePreview record={record} />
      </PreviewCardPopup>
    </PreviewCard>
  );
}
