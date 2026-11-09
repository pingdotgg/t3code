import * as Schema from "effect/Schema";
import * as Dialog from "./Dialog";
import { useContext, useEffect, useEffectEvent, useState, type ComponentType } from "react";

import { loadLocalAttachmentPreview } from "../../lib/localAttachmentPreview";
import {
  downloadAndShareAttachment,
  nativeViewerErrorMessage,
  shareLocalAttachment,
} from "../../lib/attachmentDownload";
import { usePreviewPresentation } from "../../lib/previewPresentation";
import { refreshAssetUrl } from "../../state/assets";
import { filePreviewGallery, filePreviewKey, filePreviewName } from "../../lib/filePreviewGallery";
import { FilePreviewGallery } from "./FilePreviewGallery";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";
import type {
  FilePreviewItem,
  FilePreviewModalProps,
  FilePreviewSource,
  FilePreviewViewerProps,
} from "./FilePreviewModal.types";

interface FilePreviewSessionOptions {
  /** Opens before every image resolves; the viewer takes later URLs as they arrive. */
  readonly progressiveGallery: boolean;
  readonly Viewer: ComponentType<FilePreviewViewerProps>;
}

class PreviewResolutionError extends Schema.TaggedError<PreviewResolutionError>()(
  "PreviewResolutionError",
  { cause: Schema.Defect(), fallbackMessage: Schema.String },
) {
  override get message(): string {
    return this.fallbackMessage;
  }
}

const isPreviewResolutionError = Schema.is(PreviewResolutionError);

interface ResolvedPreviewUri {
  readonly uri: string;
  readonly dispose?: () => void;
}

async function resolvePreviewUri(
  item: FilePreviewItem,
  signal: AbortSignal,
): Promise<ResolvedPreviewUri | null> {
  if ("uri" in item) return { uri: item.uri };
  if ("attachment" in item) {
    return loadLocalAttachmentPreview(item.attachment, signal).catch((error: unknown) => {
      throw new PreviewResolutionError({
        cause: error,
        fallbackMessage: "Attach the file again and retry.",
      });
    });
  }
  // Refresh expired URLs before handing them to Quick Look or ACTION_VIEW, which retain them.
  const url = await refreshAssetUrl(item.environmentId, item.resource, signal)
    .then((value) => {
      if (!value) throw new Error("Reconnect to this environment and try again.");
      return value;
    })
    .catch((error: unknown) => {
      throw new PreviewResolutionError({
        cause: error,
        fallbackMessage:
          "Reconnect to this environment and try again. The file may have been moved or deleted.",
      });
    });
  return { uri: url + (item.srcFragment ?? "") };
}

// Shares from the unresolved item so remote URLs refresh and draft files take their own lease.
function pdfActionsSource(item: FilePreviewItem): MediaActionsSource {
  const metadata = {
    name: filePreviewName(item),
    mimeType: item.mimeType ?? "application/pdf",
    ...(item.sourceIdentifier ? { sourceIdentifier: item.sourceIdentifier } : {}),
  };
  if ("uri" in item) return { ...metadata, uri: item.uri };
  if ("attachment" in item) return { ...metadata, attachment: item.attachment };
  return { ...metadata, environmentId: item.environmentId, resource: item.resource };
}

function ResolvedFilePreview(
  props: FilePreviewSessionOptions & {
    readonly source: FilePreviewSource;
    readonly onRequestClose: () => void;
    readonly onOpenError?: (error: unknown) => void;
  },
) {
  const { progressiveGallery, Viewer } = props;
  // Freeze the group at opening; streaming messages and URL refreshes must not reopen the viewer.
  const [items] = useState(() => filePreviewGallery(props.source, []));
  const selectedKey = filePreviewKey(props.source);
  const selectedIndex = items.findIndex((item) => filePreviewKey(item) === selectedKey);
  // Undefined while resolving, null once it cannot be.
  const [uris, setUris] = useState<readonly (string | null | undefined)[]>(() =>
    items.map((item) => ("uri" in item ? item.uri : undefined)),
  );
  const onResolutionError = useEffectEvent((error: PreviewResolutionError) => {
    if (props.onOpenError) props.onOpenError(error.cause);
    else Dialog.alert("Could not open preview", error.fallbackMessage);
    props.onRequestClose();
  });
  // Resolves once per presentation and holds local file leases until it closes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves preview files and holds their local file leases until the preview closes
  useEffect(() => {
    const controller = new AbortController();
    const leases: (() => void)[] = [];
    const settle = (index: number, uri: string | null) =>
      setUris((current) => current.map((value, at) => (at === index ? uri : value)));
    items.forEach((item, index) => {
      if ("uri" in item) return;
      void resolvePreviewUri(item, controller.signal).then(
        (resolved) => {
          if (controller.signal.aborted) return resolved?.dispose?.();
          if (resolved?.dispose) leases.push(resolved.dispose);
          settle(index, resolved?.uri ?? null);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (progressiveGallery && index !== selectedIndex) return settle(index, null);
          controller.abort();
          onResolutionError(
            isPreviewResolutionError(error)
              ? error
              : new PreviewResolutionError({ cause: error, fallbackMessage: "Try again." }),
          );
        },
      );
    });
    return () => {
      controller.abort();
      for (const dispose of leases) dispose();
    };
  }, [items, selectedIndex, progressiveGallery]);
  const selected = { ...items[selectedIndex]!, name: filePreviewName(items[selectedIndex]!) };
  if (selected.kind === "image") {
    // A viewer that resets image gestures when its sources change waits for every image.
    if (!progressiveGallery && uris.some((uri) => uri === undefined)) return null;
    const images = items.map((item, index) => {
      const uri = uris[index];
      return {
        ...item,
        name: filePreviewName(item),
        ...(uri ? { uri } : uri === null ? { failed: true } : {}),
      };
    });
    return (
      <Viewer
        source={{ kind: "image", images, selectedIndex }}
        onRequestClose={props.onRequestClose}
        {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
      />
    );
  }
  const uri = uris[selectedIndex];
  if (!uri) return null;
  const onOpenError = (error: unknown) => {
    if (props.onOpenError) return props.onOpenError(error);
    Dialog.alert("Could not open preview", nativeViewerErrorMessage(error), [
      { text: "Cancel", style: "cancel" },
      ...(selected.kind === "document"
        ? [
            {
              text: "Save or share",
              onPress: () => {
                const input = {
                  attachment: {
                    name: selected.name,
                    mimeType: selected.mimeType ?? "application/octet-stream",
                  },
                  signal: new AbortController().signal,
                };
                const sharing = /^(file|content):/.test(uri)
                  ? shareLocalAttachment({ ...input, uri })
                  : downloadAndShareAttachment({ ...input, url: uri });
                void sharing.catch(() => Dialog.alert("Could not share file", "Please try again."));
              },
            },
          ]
        : []),
    ]);
  };
  const actionsSource =
    selected.kind === "pdf" ? (selected.actionsSource ?? pdfActionsSource(selected)) : undefined;
  return (
    <Viewer
      source={{
        ...selected,
        kind: selected.kind,
        uri,
        ...(actionsSource ? { actionsSource } : {}),
      }}
      onRequestClose={props.onRequestClose}
      onOpenError={onOpenError}
    />
  );
}

/**
 * The part of FilePreviewModal both platforms share: it resolves sources, freezes the gallery
 * at opening and closes with its screen. Each platform's FilePreviewModal passes its viewer.
 */
export function FilePreviewSession(props: FilePreviewModalProps & FilePreviewSessionOptions) {
  const group = useContext(FilePreviewGallery);
  const source =
    props.source === null
      ? null
      : { ...props.source, gallery: filePreviewGallery(props.source, group) };
  usePreviewPresentation(source && filePreviewKey(source), props.onRequestClose);

  if (!source) return null;
  return (
    <ResolvedFilePreview
      key={filePreviewKey(source)}
      source={source}
      onRequestClose={props.onRequestClose}
      progressiveGallery={props.progressiveGallery}
      Viewer={props.Viewer}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
