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
} from "@t3tools/contracts";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, type ReactElement } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useT } from "../../hooks/useI18n";
import { downloadMedia, readMediaPng } from "./mediaContent";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
}

const FAILURE_TITLE_KEYS = {
  "copy-full-path": "review.media.failed.copyFullPath",
  "copy-relative-path": "review.media.failed.copyRelativePath",
  "copy-url": "review.media.failed.copyUrl",
  "open-file": "review.media.failed.openInFileViewer",
  "save-image": "review.media.failed.saveImage",
  "save-video": "review.media.failed.saveVideo",
  "copy-image": "review.media.failed.copyImage",
} as const satisfies Record<string, MessageKey>;

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
  const t = useT();
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
      throw new Error(t("review.media.error.hostFiles"));
    }
  };
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const actionUrl = async () => {
    assertCanReadMedia();
    if (!source.asset) {
      if (!source.src) throw new Error(t("review.media.error.unavailable"));
      return source.src;
    }
    const { environmentId, resource } = source.asset;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error(t("review.media.error.reconnect"));
    const result = await createAssetUrl({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    assertCanReadMedia();
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error(t("review.media.error.invalidUrl"));
    return url;
  };
  const save = async () => {
    await downloadMedia(await actionUrl(), mediaFileName(source));
  };
  const copyImage = async () => {
    assertCanReadMedia();
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error(t("review.media.error.copyUnavailable"));
    }
    // Start the clipboard write in the user gesture; fetching/decoding may finish later.
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": actionUrl().then(readMediaPng) }),
    ]);
  };
  return { save, copyImage, canReadMedia, assertCanReadMedia };
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
  const t = useT();
  const { save, copyImage, canReadMedia, assertCanReadMedia } = useMediaActions(source);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);
  const reference = source.reference;
  const tooltip = reference?.kind === "file" ? reference.path : (reference?.url ?? source.name);

  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    menuOpen.current = true;
    setTooltipOpen(false);
    let failureTitle = t("review.media.failed.menu");
    let progressToast: ReturnType<typeof toastManager.add> | undefined;
    const result = await settlePromise(async () => {
      const unavailable = !canReadMedia || (source.src === null && source.asset === undefined);
      const canCopyImage =
        typeof navigator !== "undefined" &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== "undefined";
      const items: ContextMenuItem<MediaActionId>[] = [];
      if (reference?.kind === "file") {
        items.push({ id: "copy-full-path", label: t("review.media.menu.copyFullPath") });
        if (reference.relativePath)
          items.push({ id: "copy-relative-path", label: t("review.media.menu.copyRelativePath") });
      } else if (reference?.kind === "url") {
        items.push({ id: "copy-url", label: t("review.media.menu.copyUrl") });
      }
      if (source.onOpenFile)
        items.push({
          id: "open-file",
          label: t("review.media.menu.openInFileViewer"),
          disabled: !canReadMedia,
        });
      items.push({
        id: "save",
        label: t(
          source.kind === "image" ? "review.media.menu.saveImage" : "review.media.menu.saveVideo",
        ),
        disabled: unavailable,
      });
      if (source.kind === "image") {
        items.push({
          id: "copy-image",
          label: t("review.media.menu.copyImage"),
          disabled: unavailable || !canCopyImage,
        });
      }

      const action = await api.contextMenu.show(items, position);
      if (!action) return;
      failureTitle = t(
        FAILURE_TITLE_KEYS[
          action === "save" ? (source.kind === "image" ? "save-image" : "save-video") : action
        ],
      );
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
        await writeTextToClipboard(clipboardText, reference?.kind === "file" ? "file path" : "URL");
        toastManager.add({
          type: "success",
          title: t(
            action === "copy-url"
              ? "review.media.toast.urlCopied"
              : "review.media.toast.pathCopied",
          ),
        });
      } else if (action === "open-file") {
        assertCanReadMedia();
        source.onOpenFile?.();
      } else if (action === "save" || action === "copy-image") {
        progressToast = toastManager.add({
          type: "loading",
          title: t(
            action === "save"
              ? source.kind === "image"
                ? "review.media.toast.preparingImageDownload"
                : "review.media.toast.preparingVideoDownload"
              : "review.media.toast.copyingImage",
          ),
        });
        await (action === "save" ? save() : copyImage());
        toastManager.update(progressToast, {
          type: "success",
          title: t(
            action === "save"
              ? "review.media.toast.downloadStarted"
              : "review.media.toast.imageCopied",
          ),
        });
      }
    });
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      const toast = stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : t("review.media.error.actionFailed"),
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
          void showMenu({ x: bounds.left, y: bounds.bottom });
        }}
      />
      <TooltipPopup variant="code">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
