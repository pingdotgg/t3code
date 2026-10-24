import type { ChatAttachment } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { type ChatFileAttachment, isFileAttachment, isImageAttachment } from "../../types";
import { AttachmentImage } from "../media/AttachmentImage";
import { PierreEntryIcon } from "./PierreEntryIcon";

const IMAGE_FRAME =
  "aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70";
const FILE_ROW = "flex min-w-0 items-center gap-2 py-1 text-sm";

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
                    <AttachmentImage
                      name={image.name}
                      mimeType={image.mimeType}
                      src={src}
                      alt={image.name}
                      decoding="async"
                      className="block size-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex size-full items-center justify-center px-2 text-center text-2xs text-muted-foreground/70">
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
          <>
            <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
            <span className="min-w-0 truncate">{file.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatAttachmentSize(file.sizeBytes)}
            </span>
          </>
        );
        return props.fileHref ? (
          <a
            key={file.id}
            href={props.fileHref(file)}
            download={file.name}
            className={cn(FILE_ROW, "hover:underline")}
          >
            {identity}
          </a>
        ) : props.onOpenFile ? (
          <button
            key={file.id}
            type="button"
            aria-label={`Preview ${file.name}`}
            onClick={() => props.onOpenFile?.(file)}
            className={cn(FILE_ROW, "cursor-pointer hover:underline")}
          >
            {identity}
          </button>
        ) : (
          <div key={file.id} className={FILE_ROW}>
            {identity}
          </div>
        );
      })}
    </div>
  );
}
