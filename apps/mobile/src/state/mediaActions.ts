import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../components/ui/Dialog";
import type { MediaActionsSource } from "../lib/mediaActionsSource";
import { useNavigation } from "@react-navigation/native";
import {
  formatFilePathForClipboard,
  type MediaActionId,
} from "@t3tools/client-runtime/media-actions";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";

import { useRefreshAssetUrl } from "./assets";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";
import {
  downloadAndShareAttachment,
  downloadAttachmentForPreview,
  shareLocalAttachment,
} from "../lib/attachmentDownload";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { canSaveImageToLibrary, saveImageToLibrary } from "../lib/saveImageToLibrary";

function allowsHostMedia(session: SessionGrantInput | null) {
  return session === null || sessionGrantsScope(session, AuthFilesystemReadScope);
}

function canReadHostMedia(environmentId: EnvironmentId | null): boolean {
  if (environmentId === null) return true;
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return result._tag !== "Failure" && allowsHostMedia(AsyncResult.getOrElse(result, () => null));
}

export function useMediaActions(source: MediaActionsSource | undefined, onOpenFile?: () => void) {
  const navigation = useNavigation();
  const hostEnvironmentId =
    source &&
    "resource" in source &&
    (source.resource._tag === "workspace-file" || source.resource._tag === "media-file")
      ? source.environmentId
      : null;
  const fileSession = useEnvironmentQuery(
    hostEnvironmentId === null ? null : environmentSession.sessionStateAtom(hostEnvironmentId),
  );
  const canReadMedia =
    hostEnvironmentId === null ||
    (fileSession.error === null && fileSession.data !== null && allowsHostMedia(fileSession.data));
  const refresh = useRefreshAssetUrl(
    source && "environmentId" in source ? source.environmentId : null,
    source && "resource" in source ? source.resource : null,
  );
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<"share" | "save-image" | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight media task when the component unmounts
  useEffect(() => () => controller.current?.abort(), []);

  const run = (
    kind: "share" | "save-image",
    task: (source: MediaActionsSource, signal: AbortSignal) => Promise<void>,
  ) => {
    if (!source || controller.current || !canReadHostMedia(hostEnvironmentId)) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(kind);
    return task(source, request.signal)
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Dialog.alert(
            kind === "share" ? "Could not share file" : "Could not save image",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (controller.current === request) {
          controller.current = null;
          if (!request.signal.aborted) setBusy(null);
        }
      });
  };

  const hostUri = async (source: MediaActionsSource, signal: AbortSignal) => {
    const uri = "uri" in source ? normalizeNativeMarkdownUrl(source.uri) : await refresh();
    if (signal.aborted || !canReadHostMedia(hostEnvironmentId)) return null;
    if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
    return uri;
  };

  const share = () =>
    run("share", async (source, signal) => {
      if ("attachment" in source) {
        const preview = await loadLocalAttachmentPreview(source.attachment, signal);
        if (!preview) return;
        const shared = await settlePromise(() => preview.share(signal, source.sourceIdentifier));
        preview.dispose();
        if (AsyncResult.isFailure(shared)) throw squashAtomCommandFailure(shared);
        return;
      }
      const uri = await hostUri(source, signal);
      if (uri === null) return;
      const input = {
        attachment: { name: source.name, mimeType: source.mimeType },
        signal,
        sourceIdentifier: source.sourceIdentifier,
      };
      if (/^(file|content):/i.test(uri)) await shareLocalAttachment({ ...input, uri });
      else await downloadAndShareAttachment({ ...input, url: uri });
    });

  const localImageFile = async (source: MediaActionsSource, signal: AbortSignal) => {
    if ("attachment" in source) return loadLocalAttachmentPreview(source.attachment, signal);
    const uri = await hostUri(source, signal);
    if (uri === null) return null;
    if (/^(file|content):/i.test(uri)) return { uri, dispose: () => {} };
    return downloadAttachmentForPreview({
      url: uri,
      attachment: { name: source.name, mimeType: source.mimeType },
      signal,
    });
  };

  const saveImage = () =>
    run("save-image", async (source, signal) => {
      const file = await localImageFile(source, signal);
      if (!file) return;
      const saved = signal.aborted
        ? null
        : await settlePromise(() => saveImageToLibrary(file.uri, source.mimeType, source.name));
      file.dispose();
      if (saved === null) return;
      if (AsyncResult.isFailure(saved)) throw squashAtomCommandFailure(saved);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    });

  const reference = source?.reference;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const threadId = source && "threadId" in source ? source.threadId : undefined;
  const actions: { id: MediaActionId; title: string; run: () => void; disabled?: boolean }[] =
    source
      ? [
          ...(reference?.kind === "file"
            ? [
                {
                  id: "copy-full-path" as const,
                  title: "Copy full path",
                  run: () => copyTextWithHaptic(formatFilePathForClipboard(reference.path)),
                },
              ]
            : []),
          ...(relativePath && reference?.kind === "file"
            ? [
                {
                  id: "copy-relative-path" as const,
                  title: "Copy relative path",
                  run: () =>
                    copyTextWithHaptic(formatFilePathForClipboard(relativePath, reference.path)),
                },
              ]
            : []),
          ...(reference?.kind === "url"
            ? [
                {
                  id: "copy-url" as const,
                  title: "Copy URL",
                  run: () => copyTextWithHaptic(reference.url),
                },
              ]
            : []),
          ...(relativePath && "environmentId" in source && threadId !== undefined
            ? [
                {
                  id: "open-file" as const,
                  title: "Open in file viewer",
                  disabled: !canReadMedia,
                  run: () => {
                    if (!canReadHostMedia(hostEnvironmentId)) return;
                    onOpenFile?.();
                    navigation.navigate("ThreadFile", {
                      environmentId: String(source.environmentId),
                      threadId: String(threadId),
                      path: relativePath.split("/"),
                    });
                  },
                },
              ]
            : []),
          ...(canSaveImageToLibrary(source.mimeType)
            ? [
                {
                  id: "save-image" as const,
                  title: busy === "save-image" ? "Saving image…" : "Save image",
                  run: saveImage,
                  disabled: busy !== null || !canReadMedia,
                },
              ]
            : []),
          {
            id: "save" as const,
            title:
              busy === "share"
                ? "Opening share sheet…"
                : canSaveImageToLibrary(source.mimeType)
                  ? "Share"
                  : "Save or share",
            run: share,
            disabled: busy !== null || !canReadMedia,
          },
        ]
      : [];
  return {
    title: reference?.kind === "file" ? reference.path : reference?.url,
    actions,
    sharing: busy === "share",
    share,
  };
}
