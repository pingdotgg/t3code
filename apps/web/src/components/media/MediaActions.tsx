import type { MediaActionId } from "@t3tools/client-runtime/media-actions";
import {
  mediaReferenceFileName,
  type MediaReference,
} from "@t3tools/client-runtime/media-reference";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef, useState, type ReactElement } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { downloadMedia, readMediaPng, readVideoFrame } from "./mediaContent";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
  /** Receives a still of the paused frame, as a data URL, to cite a region from. */
  readonly onCiteFrame?: (still: { readonly src: string; readonly seconds: number }) => void;
}

function mediaFileName(source: MediaActionSource): string {
  return (
    (source.reference && mediaReferenceFileName(source.reference)) || source.name || source.kind
  );
}

/** Explicit byte operations get fresh capabilities without replacing a player's active source. */
export function useMediaActionUrl(source: MediaActionSource): () => Promise<string> {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (!source.asset) {
      if (!source.src) throw new Error("This media is unavailable. Try reopening the preview.");
      return source.src;
    }
    const { environmentId, resource } = source.asset;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("Reconnect to this environment and try again.");
    const result = await createAssetUrl({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid media URL.");
    return url;
  }, [source, createAssetUrl]);
}

function useMediaActions(source: MediaActionSource) {
  const actionUrl = useMediaActionUrl(source);
  const save = useCallback(async () => {
    await downloadMedia(await actionUrl(), mediaFileName(source));
  }, [actionUrl, source]);
  const copyImage = useCallback(async () => {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error(
        "Image copying is unavailable. Use a secure browser connection or save the image.",
      );
    }
    // Start the clipboard write in the user gesture; fetching/decoding may finish later.
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": actionUrl().then(readMediaPng) }),
    ]);
  }, [actionUrl]);
  return { save, copyImage, actionUrl };
}

/** Adds source-aware actions and a tooltip to the existing media element without a layout wrapper. */
export function MediaActions({
  source,
  children,
}: {
  source: MediaActionSource;
  children: ReactElement;
}) {
  const { save, copyImage, actionUrl } = useMediaActions(source);
  const composerRef = useComposerHandleContext();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);
  const reference = source.reference;
  const tooltip = reference?.kind === "file" ? reference.path : (reference?.url ?? source.name);

  const showMenu = async (position: { x: number; y: number }, video: HTMLVideoElement | null) => {
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    menuOpen.current = true;
    setTooltipOpen(false);
    let failureTitle = "Could not open media menu";
    let progressToast: ReturnType<typeof toastManager.add> | undefined;
    try {
      const noun = source.kind === "image" ? "image" : "video";
      const unavailable = source.src === null && source.asset === undefined;
      const canCopyImage =
        typeof navigator !== "undefined" &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== "undefined";
      const items: ContextMenuItem<MediaActionId>[] = [];
      if (reference?.kind === "file") {
        items.push({ id: "copy-full-path", label: "Copy full path" });
        if (reference.relativePath)
          items.push({ id: "copy-relative-path", label: "Copy relative path" });
      } else if (reference?.kind === "url") {
        items.push({ id: "copy-url", label: "Copy URL" });
      }
      // A frame is only worth capturing when a mounted composer can take the citation.
      if (source.kind === "video" && source.onCiteFrame && video && composerRef?.current) {
        items.push({ id: "cite-region", label: "Cite frame" });
      }
      if (source.onOpenFile) items.push({ id: "open-file", label: "Open in file viewer" });
      items.push({ id: "save", label: `Save ${noun}`, disabled: unavailable });
      if (source.kind === "image") {
        items.push({
          id: "copy-image",
          label: "Copy image",
          disabled: unavailable || !canCopyImage,
        });
      }

      const action = await api.contextMenu.show(items, position);
      if (!action) return;
      failureTitle = `Could not ${items.find((item) => item.id === action)?.label.toLowerCase() ?? "complete media action"}`;
      const text =
        action === "copy-full-path" && reference?.kind === "file"
          ? reference.path
          : action === "copy-relative-path" && reference?.kind === "file"
            ? reference.relativePath
            : action === "copy-url" && reference?.kind === "url"
              ? reference.url
              : undefined;
      if (text !== undefined) {
        await writeTextToClipboard(text, reference?.kind === "file" ? "file path" : "URL");
        toastManager.add({
          type: "success",
          title: action === "copy-url" ? "URL copied" : "Path copied",
        });
      } else if (action === "open-file") {
        source.onOpenFile?.();
      } else if (action === "cite-region" && video && source.onCiteFrame) {
        video.pause();
        const seconds = video.currentTime;
        progressToast = toastManager.add({ type: "loading", title: "Capturing frame…" });
        const still = await readVideoFrame(actionUrl, seconds, video);
        toastManager.close(progressToast);
        progressToast = undefined;
        source.onCiteFrame({ src: still, seconds });
      } else if (action === "save" || action === "copy-image") {
        progressToast = toastManager.add({
          type: "loading",
          title: action === "save" ? `Preparing ${noun} download…` : "Copying image…",
        });
        await (action === "save" ? save() : copyImage());
        toastManager.update(progressToast, {
          type: "success",
          title: action === "save" ? "Download started" : "Image copied",
        });
      }
    } catch (error) {
      const toast = stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "The media action failed.",
      });
      if (progressToast) toastManager.update(progressToast, toast);
      else toastManager.add(toast);
    } finally {
      menuOpen.current = false;
    }
  };

  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger
        render={children}
        tabIndex={0}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu(
            event.clientX === 0 && event.clientY === 0
              ? { x: bounds.left, y: bounds.bottom }
              : { x: event.clientX, y: event.clientY },
            event.currentTarget.querySelector("video"),
          );
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu(
            { x: bounds.left, y: bounds.bottom },
            event.currentTarget.querySelector("video"),
          );
        }}
      />
      <TooltipPopup variant="code">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
