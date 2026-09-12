import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { filePreviewKind, FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import {
  CheckIcon,
  ChevronRightIcon,
  Code2,
  CopyIcon,
  DownloadIcon,
  Eye,
  Table2,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));

/** Signed asset URLs live for an hour; treat anything older than this as worth re-minting. */
const STALE_URL_MS = 5 * 60_000;

/** Highlighted read-only source, loaded on demand so message rendering never waits on the highlighter. */
export function ReadOnlySourcePreview(props: { name: string; text: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading className="p-4" />}>
      <SourcePreview {...props} />
    </Suspense>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

/**
 * A captured attachment shown with the same chrome as a workspace file: one
 * header row with crumbs and icon actions, then the document. Captured bytes
 * are viewed independently of similarly named files in the workspace.
 */
export function AttachmentFilePreview(props: {
  name: string;
  mimeType: string;
  sizeBytes: number;
  file?: Blob | null;
  asset?: { environmentId: EnvironmentId; attachmentId: string };
  /** First crumb: where the file comes from. */
  origin?: string;
  onRemove?: () => void;
  onClose?: () => void;
}) {
  const kind = filePreviewKind(props);
  const delimiter = filePreviewDelimiter(props);
  const renderedMode =
    kind === "markdown" ? "markdown" : kind === "html" ? "html" : delimiter ? "table" : null;
  const attachmentId = props.asset?.attachmentId;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: props.name });
  const resource = useMemo(
    () =>
      attachmentId
        ? {
            _tag: "attachment" as const,
            attachmentId,
            fileName: props.name,
            mimeType: props.mimeType,
            disposition: "inline" as const,
          }
        : null,
    [attachmentId, props.name, props.mimeType],
  );
  const refresh = useAssetUrlRefresh(
    props.file ? null : (props.asset?.environmentId ?? null),
    props.file ? null : resource,
  );
  const downloadResource = useMemo(
    () => (resource ? { ...resource, disposition: "attachment" as const } : null),
    [resource],
  );
  const prepareDownload = useAssetUrlRefresh(props.asset?.environmentId ?? null, downloadResource);
  const [saving, setSaving] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading source is a separate failure from loading the file: a rendered HTML page can be
  // fine while its bytes are not UTF-8, and switching back to the page must not stay stuck.
  const [contentError, setContentError] = useState<string | null>(null);
  const authorizedAt = useRef(0);
  useEffect(() => {
    if (!props.file) return;
    const url = URL.createObjectURL(props.file);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish an object URL only after its cleanup is registered for this Blob.
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [props.file]);
  useEffect(() => {
    if (props.file) return;
    let cancelled = false;
    // Await a fresh signed URL: cached links can expire while the client is suspended.
    // oxlint-disable-next-line react/set-state-in-effect -- A new preview request clears its previous URL and error.
    setRemoteUrl(null);
    setError(null);
    void refresh()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconnect to the environment and try again.");
        authorizedAt.current = Date.now();
        setRemoteUrl(url);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "The attachment is unavailable.");
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reauthorize the remote file.
  }, [props.file, refresh, revision]);
  const url = props.file ? localUrl : remoteUrl;
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  useEffect(() => {
    if (!needsText || !url) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- A new external resource must clear the previous response before loading.
    setContent(null);
    setContentError(null);
    const file = props.file;
    void (async () => {
      // A signed URL minted when the file opened may have expired by the time the user
      // switches to source. Publish its replacement so later mode switches use it too.
      if (!file && Date.now() - authorizedAt.current > STALE_URL_MS) {
        const target = await refresh();
        if (controller.signal.aborted) return;
        if (!target) throw new Error("Reconnect to the environment and try again.");
        authorizedAt.current = Date.now();
        if (target !== url) {
          setRemoteUrl(target);
          // The URL change restarts this effect; fetch once with the new authorization.
          return;
        }
      }
      const response = file
        ? { ok: true, body: file.stream() }
        : await fetch(url, {
            signal: controller.signal,
            ...(props.sizeBytes > 0
              ? { headers: { Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}` } }
              : {}),
            cache: revision === 0 ? "default" : "reload",
          });
      const result = await readFilePreviewResponse(response, controller.signal);
      if (!controller.signal.aborted) setContent(result);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setContentError(cause instanceof Error ? cause.message : "Could not load this file.");
    });
    return () => controller.abort();
  }, [url, needsText, revision, props.sizeBytes, props.file, refresh]);
  const failure = error ?? (needsText ? contentError : null);

  const save = () => {
    setSaving(true);
    void (async () => {
      try {
        let file = props.file;
        if (!file) {
          const target = await prepareDownload();
          if (!target) throw new Error("Reconnect to the environment and try again.");
          const response = await fetch(target);
          if (!response.ok) throw new Error("The file could not be loaded. Try again.");
          file = await response.blob();
        }
        // A Blob keeps cross-origin downloads inside the desktop client instead of
        // navigating its custom app scheme to an external browser.
        const downloadUrl = URL.createObjectURL(file);
        try {
          const anchor = document.createElement("a");
          anchor.href = downloadUrl;
          anchor.download = props.name;
          anchor.click();
        } finally {
          setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
        }
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: cause instanceof Error ? cause.message : "Please try again.",
        });
      } finally {
        setSaving(false);
      }
    })();
  };

  const body = failure ? (
    <FileSurfaceFailure
      message={failure}
      onRetry={() => {
        // Clearing first lets a local Blob preview remount: its URL never changes, so the
        // revision bump alone would re-render the same failed element.
        setError(null);
        setRevision((value) => value + 1);
      }}
    />
  ) : !url || (needsText && !content) ? (
    <FileSurfaceLoading />
  ) : needsText && content ? (
    delimiter && rendered ? (
      <DelimitedTablePreview name={props.name} text={content.text} delimiter={delimiter} />
    ) : kind === "markdown" && rendered ? (
      <ScrollArea className="min-h-0 flex-1">
        <ChatMarkdown text={content.text} cwd={undefined} className="mx-auto max-w-4xl px-6 py-5" />
      </ScrollArea>
    ) : (
      <ReadOnlySourcePreview name={props.name} text={content.text} />
    )
  ) : kind === "pdf" || kind === "html" ? (
    <BrowserDocumentFrame src={url} title={props.name} pdf={kind === "pdf"} />
  ) : kind === "audio" ? (
    <AudioPreview src={url} name={props.name} onError={() => setError("Unable to load audio.")} />
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        playsInline
        src={url}
        aria-label={props.name}
        className="max-h-full max-w-full"
        onError={() => setError("Unable to load video.")}
      />
    </div>
  ) : kind === "image" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={props.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setError("Unable to load image.")}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium">No preview for this file</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Save it to open in an app that supports {props.name.split(".").at(-1) || "this format"}{" "}
        files.
      </p>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={cn(FILE_SURFACE_SUBHEADER_CLASS)} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center text-xs">
          <span className="shrink-0 px-0.5 text-muted-foreground">
            {props.origin ?? "Attachment"}
          </span>
          <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            {props.name}
          </span>
          <span className="ml-2 shrink-0 text-muted-foreground">
            {formatAttachmentSize(props.sizeBytes)}
          </span>
        </div>
        {renderedMode ? (
          <FileSurfaceAction
            label={renderedToggleLabel(renderedMode, rendered)}
            pressed={rendered}
            onPress={() => setRendered((value) => !value)}
          >
            {rendered ? (
              <Code2 className="size-3.5" />
            ) : renderedMode === "table" ? (
              <Table2 className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
          </FileSurfaceAction>
        ) : null}
        {content ? (
          <FileSurfaceAction
            label={isCopied ? "Copied" : content.truncated ? "Copy preview" : "Copy contents"}
            onPress={() => copyToClipboard(content.text, undefined)}
          >
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </FileSurfaceAction>
        ) : null}
        {url ? (
          <FileSurfaceAction
            label={saving ? "Preparing file…" : "Save file"}
            disabled={saving}
            onPress={save}
          >
            <DownloadIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onRemove ? (
          <FileSurfaceAction label="Remove from draft" onPress={props.onRemove}>
            <Trash2Icon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onClose ? (
          <FileSurfaceAction label="Close" onPress={props.onClose}>
            <XIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
      </div>
      {content?.truncated ? (
        <FileSurfaceNotice>
          Preview limited to the first 1 MB of a {props.sizeBytes.toLocaleString()} byte file. Save
          the file to read it in full.
        </FileSurfaceNotice>
      ) : null}
      {body}
    </div>
  );
}
