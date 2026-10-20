import { useAtomValue } from "@effect/atom-react";
import { publishReviewAttachment } from "@t3tools/client-runtime/review-attachments";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { PaperclipIcon } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { uploadAttachmentBytes } from "~/lib/attachmentUploadQueue";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { readPreparedConnection } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Publishes media before inserting its link, so every kind of comment can share it. */
export function PullRequestAttachments({
  environmentId,
  reference,
  disabled,
  textareaRef,
  onTextChange,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  disabled?: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const target = { environmentId, input: reference };
  const detail = useEnvironmentQuery(pullRequestEnvironment.detail(target));
  const allowed = useAtomValue(
    pullRequestEnvironment.uploadAttachment.permissionAtom(environmentId),
  );
  const canTransfer = useAtomValue(
    attachmentEnvironment.createUploadUrl.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const transfer = useRef<{ cancelled: boolean; abort?: (() => void) | undefined } | null>(null);
  useEffect(
    () => () => {
      if (transfer.current) {
        transfer.current.cancelled = true;
        transfer.current.abort?.();
      }
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new PR or environment must cancel the previous upload.
    [environmentId, reference.projectId, reference.repository, reference.host, reference.number],
  );
  const canAttach =
    detail.data?.capabilities.attachments === true &&
    detail.data.viewerPermissions.attachments === true &&
    allowed &&
    canTransfer;
  const upload = async (files: File[]) => {
    if (lock.current || disabled || !canAttach || files.length === 0) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    let start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    let inserted = "";
    lock.current = true;
    const session = { cancelled: false, abort: undefined as (() => void) | undefined };
    transfer.current = session;
    setBusy(true);
    onBusyChange?.(true);
    return await (async () => {
      for (const file of files) {
        if (session.cancelled) break;
        const markdown = await publishReviewAttachment({
          registry: appAtomRegistry,
          createUploadUrl: attachmentEnvironment.createUploadUrl,
          remove: attachmentEnvironment.remove,
          publish: pullRequestEnvironment.uploadAttachment,
          environmentId,
          reference,
          isCancelled: () => session.cancelled,
          onMinted: () => (session.cancelled ? "cancel" : "continue"),
          onTransferStart: (abort) => {
            session.abort = abort;
            if (session.cancelled) abort();
          },
          upload: {
            type: "file",
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          },
          resolveUploadUrl: (relativeUrl) => {
            const connection = readPreparedConnection(environmentId);
            return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
          },
          transport: (url) =>
            uploadAttachmentBytes({
              url,
              file,
              mimeType: file.type || "application/octet-stream",
              onProgress: () => {},
            }),
        });
        if (!session.cancelled) {
          const prefix = inserted.length > 0 || (before && !before.endsWith("\n")) ? "\n\n" : "";
          inserted += `${prefix}${markdown}`;
          const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
          onTextChange(`${before}${inserted}${suffix}${after}`);
          start = before.length + inserted.length;
        }
      }
    })()
      .catch(async (error: unknown) => {
        if (!session.cancelled)
          toastManager.add({
            type: "error",
            title: "Could not attach the file",
            description: error instanceof Error ? error.message : "Try uploading again.",
          });
      })
      .finally(async () => {
        lock.current = false;
        setBusy(false);
        onBusyChange?.(false);
        if (!session.cancelled) {
          requestAnimationFrame(() => {
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(start, start);
          });
        }
      });
  };
  // File drops are handled by the same publisher as the picker, including permission and
  // cancellation checks. Ordinary pasted links remain ordinary composer text.
  useEffect(() => {
    const textarea = textareaRef.current;
    const composer =
      textarea?.closest<HTMLElement>("[data-review-attachment-composer]") ?? textarea;
    if (!composer) return;
    const isFile = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const over = (event: DragEvent) => {
      if (!isFile(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = canAttach && !disabled && !busy ? "copy" : "none";
      }
    };
    const drop = (event: DragEvent) => {
      if (!isFile(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void upload(Array.from(event.dataTransfer?.files ?? []));
    };
    composer.addEventListener("dragover", over);
    composer.addEventListener("drop", drop);
    return () => {
      composer.removeEventListener("dragover", over);
      composer.removeEventListener("drop", drop);
    };
  });
  if (!canAttach) return null;
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void upload(files);
        }}
      />
      {busy ? (
        <span role="status" className="text-xs text-muted-foreground">
          Uploading…
        </span>
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={busy ? "Uploading attachment" : "Attach files"}
        title={busy ? "Uploading attachment…" : "Attach files"}
        disabled={disabled || busy}
        onClick={() => fileInput.current?.click()}
      >
        <PaperclipIcon className="size-3.5" />
      </Button>
    </>
  );
}
