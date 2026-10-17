import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueComment,
  IssueEvent,
  IssueRichBody,
  IssueRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { ISSUES_PANEL_REF } from "~/rightPanelStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  PullRequestActorLabel,
  PullRequestCommentTime,
  PullRequestMetaLine,
} from "../pullRequest/pullRequestPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestEditButton } from "../pullRequest/PullRequestEditButton";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { PullRequestMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { IssueRichBodyEditor, IssueRichBodyView } from "./IssueRichBodyEditor";
import { isEditableIssueRichBody, safeIssueExternalUrl } from "./issueAdf";
import { issueCloseReasonLabel } from "./issuePresentation";
import { reportIssueResult } from "./issueMutation";

export function IssueCommentContent({
  environmentId,
  reference,
  comment,
  canEdit,
  richText = false,
  cwd,
  threadRef,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef & { readonly host: string };
  comment: IssueComment;
  canEdit: boolean;
  richText?: boolean;
  cwd: string;
  threadRef?: ScopedThreadRef | null;
  onChanged?: ((body: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedRich, setSavedRich] = useState<{
    base: IssueRichBody | undefined;
    value: IssueRichBody;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editComment = useAtomCommand(issueEnvironment.editComment, { reportFailure: false });
  const allowed = useAtomValue(issueEnvironment.editComment.permissionAtom(environmentId));
  if (saved !== null && saved === comment.body) setSaved(null);
  const body = saved ?? comment.body;
  const sameRichBody =
    savedRich !== null &&
    savedRich.base?.format === comment.richBody?.format &&
    savedRich.base?.document === comment.richBody?.document;
  if (savedRich !== null && !sameRichBody) setSavedRich(null);
  const richBody = savedRich !== null && sameRichBody ? savedRich.value : comment.richBody;
  const nativeRichBody = richText && isEditableIssueRichBody(richBody) ? richBody : undefined;
  const save = async (body: string, richBody?: IssueRichBody) => {
    if (
      !canEdit ||
      comment.canEdit === false ||
      !allowed ||
      saving ||
      (richBody !== undefined && !nativeRichBody)
    )
      return;
    setSaving(true);
    const result = await editComment({
      environmentId,
      input: {
        ...reference,
        commentId: comment.id,
        body,
        ...(richBody === undefined ? {} : { richBody }),
      },
    });
    setSaving(false);
    if (!reportIssueResult(result, "Could not save the comment")) return;
    setSaved(body);
    setSavedRich(richBody === undefined ? null : { base: comment.richBody, value: richBody });
    setEditing(false);
    onChanged?.(body);
  };
  return (
    <>
      <PullRequestMetaLine className="text-xs text-muted-foreground">
        <PullRequestActorLabel actor={comment.author} />
        <PullRequestCommentTime at={comment.createdAt} url={comment.url} />
        {comment.editedAt ? <span>edited</span> : null}
        {canEdit &&
        comment.canEdit !== false &&
        allowed &&
        !editing &&
        (comment.richBody === undefined || nativeRichBody !== undefined) ? (
          <PullRequestEditButton aria-label="Edit comment" onClick={() => setEditing(true)} />
        ) : null}
      </PullRequestMetaLine>
      {editing && nativeRichBody ? (
        <IssueRichBodyEditor
          value={nativeRichBody}
          label="Edit comment"
          saving={saving}
          disabled={!canEdit || comment.canEdit === false || !allowed}
          onSave={(next) => void save(body, next)}
          onCancel={() => setEditing(false)}
        />
      ) : editing && comment.richBody === undefined ? (
        <PullRequestMarkdownEditor
          value={body}
          cwd={cwd}
          environmentId={environmentId}
          label="Edit comment"
          threadRef={threadRef ?? null}
          issueLinkContext={{ ...reference, environmentId }}
          pullRequestPanelRef={threadRef ?? ISSUES_PANEL_REF}
          saving={saving}
          onSave={(next) => void save(next)}
          onCancel={() => setEditing(false)}
        />
      ) : nativeRichBody ? (
        <IssueRichBodyView value={nativeRichBody} />
      ) : (
        <PullRequestCommentBody
          text={body}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef ?? null}
          issueLinkContext={{ ...reference, environmentId }}
          pullRequestPanelRef={threadRef ?? ISSUES_PANEL_REF}
        />
      )}
    </>
  );
}

function eventSentence(event: IssueEvent): string {
  switch (event.kind) {
    case "closed":
      return event.detail
        ? `closed this as ${issueCloseReasonLabel(event.detail).toLowerCase()}`
        : "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return event.detail ? `added the ${event.detail} label` : "added a label";
    case "unlabeled":
      return event.detail ? `removed the ${event.detail} label` : "removed a label";
    case "assigned":
      return event.detail ? `assigned ${event.detail}` : "assigned someone";
    case "unassigned":
      return event.detail ? `unassigned ${event.detail}` : "unassigned someone";
    case "renamed":
      return event.detail ? `renamed this to "${event.detail}"` : "renamed this";
    case "referenced":
      return event.reference
        ? "referenced this from"
        : event.detail
          ? `referenced this from ${event.detail}`
          : "referenced this";
    case "state-changed":
      return event.detail ? `moved this to ${event.detail}` : "changed the state";
    case "changed":
    case "updated":
      return event.detail ? `${event.kind} ${event.detail}` : `${event.kind} this`;
  }
}

export function IssueEventRow({ event }: { event: IssueEvent }) {
  const source = event.reference;
  const sourceUrl = source && safeIssueExternalUrl(source.url) !== null ? source.url : null;
  const sourceLabel = source
    ? [source.identifier, source.title].filter(Boolean).join(" ") || source.url
    : null;
  const eventUrl = event.url && safeIssueExternalUrl(event.url) !== null ? event.url : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs [contain-intrinsic-block-size:36px] [content-visibility:auto]">
      <PullRequestActorLabel actor={event.actor} className="max-w-40" />
      <span className="text-muted-foreground">{eventSentence(event)}</span>
      {sourceUrl ? (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 break-words font-medium hover:underline"
        >
          {sourceLabel}
        </a>
      ) : sourceLabel ? (
        <span className="min-w-0 break-words">{sourceLabel}</span>
      ) : null}
      <span className="ml-auto shrink-0 text-muted-foreground">
        <Tooltip>
          <TooltipTrigger
            render={
              eventUrl ? (
                <a
                  href={eventUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground hover:underline"
                />
              ) : (
                <span />
              )
            }
          >
            <time dateTime={event.createdAt}>{formatRelativeTimeLabel(event.createdAt)}</time>
          </TooltipTrigger>
          <TooltipPopup>
            {new Date(event.createdAt).toLocaleString()}
            {eventUrl ? " · Open event on host" : ""}
          </TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
}
