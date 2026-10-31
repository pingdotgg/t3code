import type { ChatAttachment } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

import { useTheme } from "~/hooks/useTheme";
import { InlineButton } from "../ui/button";
import { type ChatFileAttachment, isFileAttachment, isImageAttachment } from "../../types";
import { AttachmentImage } from "../media/AttachmentImage";
import { PierreEntryIcon } from "./PierreEntryIcon";

const IMAGE_FRAME =
  "aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70";
const FILE_ROW = "flex min-w-0 items-center gap-2 py-1 text-body";

/**
 * A guest message's files, drawn like a sent message's: image thumbnails, then file rows. The
 * owner opens them in the app; the guest loads them from the guest route.
 */
export function GuestMessageAttachments(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Where an image loads from; undefined while its URL is not ready. */
  readonly imageUrl: (attachment: ChatAttachment) => string | undefined;
  readonly onOpenImage: (attachment: ChatAttachment) => void;
  /** A file row as a link, or a button that calls `onOpenFile`. */
  readonly fileHref?: (attachment: ChatFileAttachment) => string;
  readonly onOpenFile?: (attachment: ChatFileAttachment) => void;
}) {
  const { resolvedTheme } = useTheme();
  const images = props.attachments.filter(isImageAttachment);
  const files = props.attachments.filter(isFileAttachment);
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-2">
      {images.length > 0 ? (
        <div className="grid w-[210px] grid-cols-2 gap-2">
          {images.map((image) => {
            const src = props.imageUrl(image);
            return (
              <div key={image.id} className={IMAGE_FRAME}>
                {src ? (
                  <button
                    type="button"
                    className="block size-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => props.onOpenImage(image)}
                  >
                    {/* Isolate the thumbnail raster from nearby activity repaints in Chromium. */}
                    <AttachmentImage
                      name={image.name}
                      mimeType={image.mimeType}
                      src={src}
                      alt={image.name}
                      decoding="async"
                      className="block size-full transform-gpu object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex size-full items-center justify-center px-2 text-center text-caption text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {files.map((file) => {
        const identity = (
          <span className="flex min-w-0 items-center gap-2">
            <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
            <span className="min-w-0 truncate">{file.name}</span>
            <span className="shrink-0 text-meta text-muted-foreground">
              {formatAttachmentSize(file.sizeBytes)}
            </span>
          </span>
        );
        return props.fileHref ? (
          <InlineButton
            key={file.id}
            className="min-w-0"
            render={<a href={props.fileHref(file)} download={file.name} />}
          >
            {identity}
          </InlineButton>
        ) : props.onOpenFile ? (
          <InlineButton
            key={file.id}
            type="button"
            aria-label={`Preview ${file.name}`}
            onClick={() => props.onOpenFile?.(file)}
            className="min-w-0"
          >
            {identity}
          </InlineButton>
        ) : (
          <div key={file.id} className={FILE_ROW}>
            {identity}
          </div>
        );
      })}
    </div>
  );
}
