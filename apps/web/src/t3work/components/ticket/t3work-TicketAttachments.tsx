import { ExternalLink, FileText, Image as ImageIcon } from "lucide-react";
import { Card, CardContent } from "~/t3work/components/ui/t3work-card";
import type { JiraAttachment } from "./t3work-ticketRichContentTypes";
import { formatFileSize } from "./t3work-ticketRichContentUtils";

export function TicketAttachments({ attachments }: { attachments: JiraAttachment[] }) {
  if (attachments.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Attachments</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {attachments.map((attachment, index) => {
            const name = attachment.filename?.trim() || `Attachment ${index + 1}`;
            const mime = attachment.mimeType ?? "file";
            const href = attachment.content ?? attachment.thumbnail ?? "";
            const isImage = mime.startsWith("image/");
            const sizeText = formatFileSize(attachment.size);

            return (
              <a
                key={`${attachment.id ?? name}-${index}`}
                href={href || undefined}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-border bg-background p-3 transition-colors hover:bg-accent/40"
              >
                <div className="mb-2 flex items-center gap-2">
                  {isImage ? (
                    <ImageIcon className="size-4 text-muted-foreground" />
                  ) : (
                    <FileText className="size-4 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                  {href && <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />}
                </div>
                {isImage && href && (
                  <img
                    src={attachment.thumbnail ?? href}
                    alt={name}
                    className="mb-2 max-h-44 w-full rounded-md border border-border object-cover"
                    loading="lazy"
                  />
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{mime}</span>
                  {sizeText && (
                    <>
                      <span>•</span>
                      <span>{sizeText}</span>
                    </>
                  )}
                </div>
              </a>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
