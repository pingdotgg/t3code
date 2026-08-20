import type { EnvironmentId, IssueComment, IssueDetailView, IssueRef } from "@t3tools/contracts";
import { CircleDotIcon, PencilIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "~/localApi";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ConversationGroup } from "../sourceControl/ConversationGroup";
import { HostMarkdown } from "../sourceControl/HostMarkdown";
import { ActorName, IconMarker } from "../sourceControl/TimelineRail";
import { SourceControlMarkdownEditor } from "../pullRequest/PullRequestMarkdownEditor";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { IssueReactionBar } from "./IssueReactions";
import {
  buildIssueTimeline,
  canEditIssueComment,
  issueCommentEditId,
  type IssueCommentEditScope,
  groupIssueTimelineConversations,
  type IssueTimelineEntry,
} from "./issueDetail.logic";

/**
 * An event wears the issue glyph rather than whoever caused it. A face here is a filled disc on
 * every row of the rail, which reads as a column of blobs the line runs between; the glyph keeps
 * the rail the continuous thing and leaves the avatars to say what they say on a pull request —
 * that a run of comments has people in it.
 */
function TimelineEvent({ entry }: { entry: IssueTimelineEntry }) {
  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <IconMarker icon={<CircleDotIcon className="size-3.5" />} />
      <div className="py-1.5 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ActorName actor={entry.actor} />
          <span className="min-w-0 text-muted-foreground">{entry.title}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTimeLabel(entry.at)}
        </div>
      </div>
    </div>
  );
}

export function IssueTimelineTab({
  environmentId,
  reference,
  detail,
  order,
  onRefresh,
  onLoadMoreComments,
  loadingMoreComments,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetailView;
  /** The rail is built oldest first, which is how an issue was written and how it reads. */
  order: "newest" | "oldest";
  onRefresh: () => void;
  onLoadMoreComments: () => void;
  loadingMoreComments: boolean;
}) {
  const entries = buildIssueTimeline(detail);
  const rows = groupIssueTimelineConversations(order === "oldest" ? entries : entries.toReversed());
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };
  const comments = new Map(detail.comments.map((comment) => [comment.id, comment]));
  const [editingScope, setEditingScope] = useState<IssueCommentEditScope | null>(null);
  const editingId = issueCommentEditId(editingScope, detail.url);
  const [saving, setSaving] = useState(false);
  const updateComment = useAtomCommand(issueEnvironment.updateComment, { reportFailure: false });

  const editableComment = (entry: IssueTimelineEntry): IssueComment | null => {
    const comment = comments.get(entry.id);
    return comment !== undefined && canEditIssueComment(detail, comment) ? comment : null;
  };
  const saveComment = async (comment: IssueComment, body: string) => {
    if (saving) return;
    setSaving(true);
    const result = await updateComment({
      environmentId,
      input: { ...reference, commentId: comment.id, body },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not save the comment" });
      return;
    }
    setEditingScope(null);
    onRefresh();
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-3xl">
        {detail.nextCommentsCursor != null ? (
          <Button
            size="sm"
            variant="outline"
            className="mb-4 w-full"
            disabled={loadingMoreComments}
            onClick={onLoadMoreComments}
          >
            {loadingMoreComments ? "Loading..." : "Load older comments"}
          </Button>
        ) : null}
        <div className="relative">
          <span aria-hidden className="absolute bottom-5 left-[15px] top-1 w-px bg-border/45" />
          {rows.map((row) =>
            row.kind === "comments" ? (
              <ConversationGroup
                key={`comments:${row.key}`}
                entries={row.entries}
                onOpen={openOnHost}
                renderActions={(entry) => {
                  const comment = editableComment(entry);
                  return comment === null || editingId === entry.id ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="-mt-1 shrink-0 text-muted-foreground"
                      aria-label="Edit comment"
                      onClick={() => setEditingScope({ issue: detail.url, id: entry.id })}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  );
                }}
                renderBody={(entry) => {
                  const comment = editableComment(entry);
                  return editingId === entry.id && comment !== null ? (
                    <SourceControlMarkdownEditor
                      value={comment.body}
                      cwd={detail.workspaceRoot}
                      label="Edit comment"
                      saving={saving}
                      onSave={(body) => void saveComment(comment, body)}
                      onCancel={() => setEditingScope(null)}
                    />
                  ) : entry.body === null ? null : (
                    <div className="group">
                      <HostMarkdown text={entry.body} cwd={detail.workspaceRoot} />
                      <IssueReactionBar
                        className="mt-2"
                        reactions={comments.get(entry.id)?.reactions ?? []}
                        canReact={detail.capabilities.reactions === true}
                        subjectId={entry.id}
                        environmentId={environmentId}
                        reference={reference}
                        onRefresh={onRefresh}
                      />
                    </div>
                  );
                }}
              />
            ) : (
              <TimelineEvent key={row.entry.id} entry={row.entry} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
