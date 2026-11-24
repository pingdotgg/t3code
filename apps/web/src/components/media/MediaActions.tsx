import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { contextMenuSourceOf } from "../../contextMenuSource";
import {
  formatFilePathForClipboard,
  type MediaActionId,
} from "@t3tools/client-runtime/media-actions";
import {
  mediaReferenceFileName,
  type MediaReference,
} from "@t3tools/client-runtime/media-reference";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  type AssetResource,
  type ContextMenuItem,
  type EnvironmentId,
  sessionGrantsScope,
  type SessionGrantInput,
  type ContextMenuSource,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { useRef, useState, type ReactElement } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, readPreparedConnection } from "../../state/session";
import { m } from "../../i18n/messages";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { downloadMedia, readMediaPng } from "./mediaContent";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
}

function mediaFileName(source: MediaActionSource): string {
  return (
    (source.reference && mediaReferenceFileName(source.reference)) || source.name || source.kind
  );
}

function allowsHostMedia(session: SessionGrantInput | null) {
  return session === null || sessionGrantsScope(session, AuthFilesystemReadScope);
}

function canReadHostMedia(environmentId: EnvironmentId | null): boolean {
  if (environmentId === null) return true;
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return result._tag !== "Failure" && allowsHostMedia(AsyncResult.getOrElse(result, () => null));
}

export function useMediaActions(source: MediaActionSource) {
  const hostEnvironmentId =
    source.asset &&
    (source.asset.resource._tag === "workspace-file" || source.asset.resource._tag === "media-file")
      ? source.asset.environmentId
      : null;
  const fileSession = useEnvironmentQuery(
    hostEnvironmentId === null ? null : environmentSession.sessionStateAtom(hostEnvironmentId),
  );
  const canReadMedia =
    hostEnvironmentId === null ||
    (fileSession.error === null && fileSession.data !== null && allowsHostMedia(fileSession.data));
  const assertCanReadMedia = () => {
    if (!canReadHostMedia(hostEnvironmentId)) {
      throw new Error(m(msg("This connection cannot read host files.")));
    }
  };
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const actionUrl = async () => {
    assertCanReadMedia();
    if (!source.asset) {
      if (!source.src) {
        throw new Error(m(msg("This media is unavailable. Try reopening the preview.")));
      }
      return source.src;
    }
    const { environmentId, resource } = source.asset;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error(m(msg("Reconnect to this environment and try again.")));
    const result = await createAssetUrl({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    assertCanReadMedia();
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error(m(msg("The environment returned an invalid media URL.")));
    return url;
  };
  const save = async () => {
    await downloadMedia(await actionUrl(), mediaFileName(source));
  };
  const copyImage = async () => {
    assertCanReadMedia();
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error(
        m(msg("Image copying is unavailable. Use a secure browser connection or save the image.")),
      );
    }
    // Start the clipboard write in the user gesture; fetching/decoding may finish later.
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": actionUrl().then(readMediaPng) }),
    ]);
  };
  return { save, copyImage, canReadMedia, assertCanReadMedia };
}

export type MediaByteAction = "save" | "copy-image";

/** Saves or copies media with the same progress and failure toasts as the media menu. */
export function useMediaByteAction(source: MediaActionSource) {
  const { save, copyImage } = useMediaActions(source);
  return async (action: MediaByteAction) => {
    const isImage = source.kind === "image";
    const progressToast = toastManager.add({
      type: "loading",
      title:
        action === "save"
          ? isImage
            ? m(msg("Preparing image download…"))
            : m(msg("Preparing video download…"))
          : m(msg("Copying image…")),
    });
    try {
      await (action === "save" ? save() : copyImage());
      toastManager.close(progressToast);
    } catch (error) {
      toastManager.update(
        progressToast,
        stackedThreadToast({
          type: "error",
          title:
            action === "save"
              ? isImage
                ? m(msg("Could not save image"))
                : m(msg("Could not save video"))
              : m(msg("Could not copy image")),
          description: thrownErrorMessage(error, m) ?? m(msg("The media action failed.")),
        }),
      );
    }
  };
}

export function MediaActions({
  source,
  children,
  showTooltip = true,
}: {
  source: MediaActionSource;
  children: ReactElement;
  showTooltip?: boolean;
}) {
  const { save, copyImage, canReadMedia, assertCanReadMedia } = useMediaActions(source);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);
  const reference = source.reference;
  const tooltip = reference?.kind === "file" ? reference.path : (reference?.url ?? source.name);

  const showMenu = async (position: { x: number; y: number }, menuSource: ContextMenuSource) => {
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    menuOpen.current = true;
    setTooltipOpen(false);
    let failureTitle = m(msg("Could not open media menu"));
    let progressToast: ReturnType<typeof toastManager.add> | undefined;
    const result = await settlePromise(async () => {
      const isImage = source.kind === "image";
      const unavailable = !canReadMedia || (source.src === null && source.asset === undefined);
      const canCopyImage =
        typeof navigator !== "undefined" &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== "undefined";
      const items: ContextMenuItem<MediaActionId>[] = [];
      if (reference?.kind === "file") {
        items.push({ id: "copy-full-path", label: m(msg("Copy full path")) });
        if (reference.relativePath)
          items.push({ id: "copy-relative-path", label: m(msg("Copy relative path")) });
      } else if (reference?.kind === "url") {
        items.push({ id: "copy-url", label: m(msg("Copy URL")) });
      }
      if (source.onOpenFile)
        items.push({
          id: "open-file",
          label: m(msg("Open in file viewer")),
          disabled: !canReadMedia,
        });
      items.push({
        id: "save",
        label: isImage ? m(msg("Save image")) : m(msg("Save video")),
        disabled: unavailable,
      });
      if (source.kind === "image") {
        items.push({
          id: "copy-image",
          label: m(msg("Copy image")),
          disabled: unavailable || !canCopyImage,
        });
      }

      const action = await api.contextMenu.show(items, position, menuSource);
      if (!action) return;
      failureTitle =
        action === "copy-full-path"
          ? m(msg("Could not copy full path"))
          : action === "copy-relative-path"
            ? m(msg("Could not copy relative path"))
            : action === "copy-url"
              ? m(msg("Could not copy url"))
              : action === "open-file"
                ? m(msg("Could not open in file viewer"))
                : action === "save"
                  ? isImage
                    ? m(msg("Could not save image"))
                    : m(msg("Could not save video"))
                  : action === "copy-image"
                    ? m(msg("Could not copy image"))
                    : m(msg("Could not complete media action"));
      const text =
        action === "copy-full-path" && reference?.kind === "file"
          ? reference.path
          : action === "copy-relative-path" && reference?.kind === "file"
            ? reference.relativePath
            : action === "copy-url" && reference?.kind === "url"
              ? reference.url
              : undefined;
      if (text !== undefined) {
        const clipboardText =
          reference?.kind === "file" ? formatFilePathForClipboard(text, reference.path) : text;
        await writeTextToClipboard(
          clipboardText,
          reference?.kind === "file"
            ? {
                target: "file path",
                unavailableMessage: msg("Clipboard API is unavailable while copying file path."),
                failureMessage: msg("Failed to copy file path to the clipboard."),
              }
            : {
                target: "URL",
                unavailableMessage: msg("Clipboard API is unavailable while copying URL."),
                failureMessage: msg("Failed to copy URL to the clipboard."),
              },
        );
      } else if (action === "open-file") {
        assertCanReadMedia();
        source.onOpenFile?.();
      } else if (action === "save" || action === "copy-image") {
        progressToast = toastManager.add({
          type: "loading",
          title:
            action === "save"
              ? isImage
                ? m(msg("Preparing image download…"))
                : m(msg("Preparing video download…"))
              : m(msg("Copying image…")),
        });
        await (action === "save" ? save() : copyImage());
        toastManager.close(progressToast);
      }
    });
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      const toast = stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: thrownErrorMessage(error, m) ?? m(msg("The media action failed.")),
      });
      if (progressToast) toastManager.update(progressToast, toast);
      else toastManager.add(toast);
    }
    menuOpen.current = false;
  };

  return (
    <Tooltip disabled={!showTooltip} open={tooltipOpen} onOpenChange={setTooltipOpen}>
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
            contextMenuSourceOf(event),
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
          void showMenu({ x: bounds.left, y: bounds.bottom }, "keyboard");
        }}
      />
      <TooltipPopup variant="code">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
