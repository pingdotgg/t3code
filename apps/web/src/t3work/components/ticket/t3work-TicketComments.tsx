import { MessageSquare } from "lucide-react";
import { Card, CardContent } from "~/t3work/components/ui/t3work-card";
import { HtmlBlock, MarkdownBlock } from "./t3work-ticketRichContentBlocks";
import type { JiraCommentItem } from "./t3work-ticketRichContentTypes";
import { formatTimestamp } from "./t3work-ticketRichContentUtils";

export function TicketComments({
  comments,
  htmlBaseUrl,
}: {
  comments: JiraCommentItem[];
  htmlBaseUrl?: string;
}) {
  if (comments.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <h3 className="text-sm font-semibold">Comments</h3>
        <div className="space-y-4">
          {comments.map((comment, index) => {
            const commentBody = comment.bodyMarkdown?.trim() ?? "";
            const commentHtml = comment.bodyHtml?.trim() ?? "";
            const timestamp = formatTimestamp(comment.updated || comment.created);

            return (
              <article
                key={`${comment.id ?? "comment"}-${index}`}
                className="rounded-lg border border-border bg-background/70 p-3"
              >
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <MessageSquare className="size-3.5" />
                  <span className="font-medium text-foreground">{comment.author ?? "Unknown"}</span>
                  {timestamp && (
                    <>
                      <span>•</span>
                      <time>{timestamp}</time>
                    </>
                  )}
                </div>
                {commentHtml ? (
                  <HtmlBlock
                    content={commentHtml}
                    {...(htmlBaseUrl ? { baseUrl: htmlBaseUrl } : {})}
                  />
                ) : commentBody ? (
                  <MarkdownBlock content={commentBody} />
                ) : (
                  <p className="text-sm text-muted-foreground">No comment body.</p>
                )}
              </article>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
