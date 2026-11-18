import { useGT, T } from "gt-react";
import { useState } from "react";
import {
  ArrowLeftIcon,
  DownloadIcon,
  ImageIcon,
  SendIcon,
  FilmIcon,
  ShareIcon,
} from "lucide-react";

import type { ExpandedImageItem } from "../chat/ExpandedImagePreview";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { downloadImageArchive, readImageArchive } from "./imageGallery.logic";
import { createAnimationFrameSheet } from "./imageAnimation";

import { AttachmentImage } from "../media/AttachmentImage";
import { MediaActions } from "../media/MediaActions";

interface ImageGalleryProps {
  readonly images: readonly ExpandedImageItem[];
  readonly onOpen: (index: number, edit?: boolean) => void;
  readonly onApply: (images: ExpandedImageItem[], prompt: string) => Promise<void>;
  readonly onClose: () => void;
  readonly readImage: (image: ExpandedImageItem) => Promise<Blob>;
  readonly onFrameSheet?: (
    image: ExpandedImageItem,
    file: File,
    context: string,
    original: File,
  ) => Promise<void>;
  readonly onBusyChange?: (busy: boolean) => void;
}

export function ImageGallery({
  images,
  onOpen,
  onApply,
  onClose,
  readImage,
  onFrameSheet,
  onBusyChange,
}: ImageGalleryProps) {
  const gt = useGT();
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"download" | "apply" | "frames" | "share" | null>(null);
  const [preparedShare, setPreparedShare] = useState<{
    readonly key: string;
    readonly file: File;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageEntries = images.flatMap((image, index) =>
    image.type === "video" ? [] : [{ image, index }],
  );
  const selectedImages = imageEntries
    .filter(({ index }) => selected.has(index))
    .map(({ image }) => image);
  const allSelected = imageEntries.length > 0 && selectedImages.length === imageEntries.length;
  const downloadImages =
    selectedImages.length > 0 ? selectedImages : imageEntries.map(({ image }) => image);
  const shareKey = JSON.stringify(
    downloadImages.map((image) => [image.src, image.actionsSource?.asset, image.name]),
  );
  const sharingAvailable =
    typeof navigator.share === "function" && typeof navigator.canShare === "function";
  const run = async (
    operation: "download" | "apply" | "frames" | "share",
    work: () => Promise<void>,
  ) => {
    if (busy !== null) return;
    setBusy(operation);
    onBusyChange?.(true);
    setError(null);
    const failure = await work().then(
      () => null,
      (cause: unknown) =>
        cause instanceof DOMException && cause.name === "AbortError"
          ? null
          : cause instanceof Error
            ? cause.message
            : gt("The image action failed."),
    );
    setBusy(null);
    onBusyChange?.(false);
    setError(failure);
  };
  const apply = () => {
    if (!prompt.trim() || selectedImages.length === 0) return;
    void run("apply", () => onApply(selectedImages, prompt.trim()));
  };
  const download = () => {
    void run("download", () =>
      downloadImageArchive(downloadImages, readImage, (image) => image.name),
    );
  };
  const share = () => {
    if (preparedShare?.key === shareKey) {
      void run("share", () =>
        navigator.share({ files: [preparedShare.file], title: gt("T3 Code images") }),
      );
      return;
    }
    void run("share", async () => {
      const blob = await readImageArchive(downloadImages, readImage, (image) => image.name);
      const file = new File([blob], "t3-images.zip", { type: "application/zip" });
      if (!navigator.canShare({ files: [file] }))
        throw new Error(
          gt("This browser cannot share ZIP files. Download the images to share them."),
        );
      setPreparedShare({ key: shareKey, file });
    });
  };
  const editFrames = (image: ExpandedImageItem) => {
    if (!onFrameSheet) return;
    void run("frames", async () => {
      const blob = await readImage(image);
      const original = new File([blob], image.name, {
        type: blob.type.startsWith("image/") ? blob.type : "image/gif",
      });
      const sheet = await createAnimationFrameSheet(blob, image.name);
      await onFrameSheet(image, sheet.file, sheet.context, original);
    });
  };

  return (
    <section
      className="@container/image-gallery flex h-full min-h-0 w-full flex-col overflow-y-auto rounded-xl border border-border bg-background text-foreground shadow-2xl"
      aria-label={gt("Conversation images")}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border p-3">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy !== null}>
          <ArrowLeftIcon aria-hidden />
          <T>Back</T>
        </Button>
        <h2 className="min-w-fit flex-1 text-sm font-medium">
          {gt("Images ({count})", { count: imageEntries.length })}
        </h2>
        {sharingAvailable && (
          <Button
            variant="outline"
            size="sm-multiline"
            className="max-w-full"
            onClick={share}
            disabled={busy !== null || imageEntries.length === 0}
          >
            <ShareIcon aria-hidden />
            {busy === "share"
              ? gt("Preparing share…")
              : preparedShare?.key === shareKey
                ? gt("Share ZIP")
                : gt("Prepare share")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm-multiline"
          className="max-w-full"
          onClick={download}
          disabled={busy !== null || imageEntries.length === 0}
        >
          <DownloadIcon aria-hidden />
          {busy === "download"
            ? gt("Preparing download…")
            : selectedImages.length > 0
              ? gt("Download {count} selected", { count: selectedImages.length })
              : gt("Download all")}
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <Checkbox
          id="image-gallery-select-all"
          checked={allSelected}
          indeterminate={!allSelected && selectedImages.length > 0}
          disabled={busy !== null || imageEntries.length === 0}
          onCheckedChange={() =>
            setSelected(allSelected ? new Set() : new Set(imageEntries.map(({ index }) => index)))
          }
        />
        <label htmlFor="image-gallery-select-all">
          <T>Select all</T>
        </label>
        <span aria-live="polite" className="text-muted-foreground">
          {gt("{count} selected", { count: selectedImages.length })}
        </span>
      </div>
      <div className="min-h-40 flex-1 overflow-y-auto p-4 pt-0">
        {imageEntries.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            <T>No images in this conversation yet.</T>
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 @xs/image-gallery:grid-cols-2 @2xl/image-gallery:grid-cols-3 @4xl/image-gallery:grid-cols-4">
            {imageEntries.map(({ image, index }) => (
              <div
                key={`${index}:${image.src ?? image.name}`}
                className="min-w-0 rounded-lg border border-border p-2 has-[[aria-checked=true]]:border-ring"
              >
                <MediaActions
                  source={
                    image.actionsSource ?? {
                      kind: "image",
                      name: image.name,
                      src: image.src,
                    }
                  }
                  showTooltip={false}
                  disabled={busy !== null}
                  onEditImage={() => onOpen(index, true)}
                >
                  <button
                    type="button"
                    className="flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={gt("Open image {number}, {name}", {
                      number: index + 1,
                      name: image.name,
                    })}
                    disabled={busy !== null}
                    onClick={() => onOpen(index)}
                  >
                    {image.src ? (
                      <AttachmentImage
                        src={image.src}
                        name={image.name}
                        mimeType={image.mimeType}
                        alt={image.name}
                        loading="lazy"
                        decoding="async"
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <ImageIcon aria-hidden className="size-8 text-muted-foreground" />
                    )}
                  </button>
                </MediaActions>
                <div className="mt-2 flex items-center gap-2">
                  <Checkbox
                    id={`image-gallery-select-${index}`}
                    checked={selected.has(index)}
                    disabled={busy !== null}
                    onCheckedChange={(checked) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  />
                  <label
                    htmlFor={`image-gallery-select-${index}`}
                    className="min-w-0 truncate text-xs"
                  >
                    {image.name}
                  </label>
                </div>
                {onFrameSheet &&
                  (image.mimeType === "image/gif" || /\.gif(?:[?#]|$)/i.test(image.name)) && (
                    <div className="mt-2 flex">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => editFrames(image)}
                        disabled={busy !== null}
                      >
                        <FilmIcon aria-hidden />
                        {busy === "frames" ? gt("Preparing frames…") : gt("Edit frames")}
                      </Button>
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-3 border-t border-border p-4">
        <label htmlFor="image-gallery-feedback" className="text-sm font-medium">
          <T>Edit selected images</T>
        </label>
        <Textarea
          id="image-gallery-feedback"
          placeholder={gt("Describe the changes to apply to every selected image…")}
          value={prompt}
          disabled={busy !== null}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return;
            event.stopPropagation();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              apply();
            }
          }}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            <T>Selected originals are attached to the chat for editing.</T>
          </p>
          <Button
            size="multiline"
            className="max-w-full"
            onClick={apply}
            disabled={busy !== null || selectedImages.length === 0 || !prompt.trim()}
          >
            <SendIcon aria-hidden />
            {busy === "apply" ? gt("Preparing images…") : gt("Add edits to chat")}
          </Button>
        </div>
      </div>
    </section>
  );
}
