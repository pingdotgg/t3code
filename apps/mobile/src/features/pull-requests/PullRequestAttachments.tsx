import { useAtomValue } from "@effect/atom-react";
import { publishReviewAttachment } from "@t3tools/client-runtime/review-attachments";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import * as DocumentPicker from "expo-document-picker";
import { File, UploadType } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { appAtomRegistry } from "../../state/atom-registry";
import { attachmentEnvironment } from "../../state/attachments";
import { composerPullRequests } from "../../state/pull-requests";
import { environmentSession } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function PullRequestAttachments({
  params,
  disabled,
  onAppend,
  onBusyChange,
}: {
  params: PullRequestParams;
  disabled?: boolean;
  onAppend: (markdown: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const allowed = useAtomValue(
    composerPullRequests.uploadAttachment.permissionAtom(target.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const scopeKey = JSON.stringify([
    params.environmentId,
    params.projectId,
    params.host,
    params.repository,
    params.number,
  ]);
  const transfer = useRef<{
    scopeKey: string;
    cancelled: boolean;
    abort?: (() => void) | undefined;
  } | null>(null);
  useEffect(
    () => () => {
      if (transfer.current?.scopeKey === scopeKey) {
        transfer.current.cancelled = true;
        transfer.current.abort?.();
      }
    },
    [scopeKey],
  );
  const upload = async () => {
    if (lock.current || disabled) return;
    lock.current = true;
    const session = { scopeKey, cancelled: false, abort: undefined as (() => void) | undefined };
    transfer.current = session;
    setBusy(true);
    onBusyChange?.(true);
    return await (async () => {
      const selection = await DocumentPicker.getDocumentAsync({
        type: [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/quicktime",
          "video/webm",
        ],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (selection.canceled) return;
      for (const asset of selection.assets) {
        const file = new File(asset.uri);
        await (async () => {
          if (session.cancelled) return;
          const mimeType = asset.mimeType || file.type || "application/octet-stream";
          const markdown = await publishReviewAttachment({
            registry: appAtomRegistry,
            createUploadUrl: attachmentEnvironment.createUploadUrl,
            remove: attachmentEnvironment.remove,
            publish: composerPullRequests.uploadAttachment,
            environmentId: target.environmentId,
            reference: target.input,
            isCancelled: () => session.cancelled,
            onMinted: () => (session.cancelled ? "cancel" : "continue"),
            onTransferStart: (abort) => {
              session.abort = abort;
              if (session.cancelled) abort();
            },
            upload: { type: "file", name: asset.name, mimeType, sizeBytes: file.size },
            resolveUploadUrl: (relativeUrl) => {
              const connection = appAtomRegistry.get(
                environmentSession.preparedConnectionValueAtom(target.environmentId),
              );
              return Option.isSome(connection)
                ? resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl)
                : null;
            },
            transport: (url) => {
              const abort = new AbortController();
              return {
                abort: () => abort.abort(),
                done: file
                  .upload(url, {
                    httpMethod: "POST",
                    uploadType: UploadType.BINARY_CONTENT,
                    headers: { "Content-Type": mimeType },
                    signal: abort.signal,
                  })
                  .then((result) => {
                    if (result.status < 200 || result.status >= 300)
                      throw new Error(`Upload failed (${result.status}).`);
                  }),
              };
            },
          });
          if (!session.cancelled) onAppend(markdown);
        })().finally(async () => {
          if (file.exists) file.delete();
        });
      }
    })()
      .catch(async (error: unknown) => {
        if (!session.cancelled)
          Alert.alert(
            "Could not attach the file",
            error instanceof Error ? error.message : "Try uploading again.",
          );
      })
      .finally(async () => {
        lock.current = false;
        setBusy(false);
        onBusyChange?.(false);
      });
  };
  if (
    !allowed ||
    !detail.data?.capabilities.attachments ||
    detail.data.viewerPermissions.attachments !== true
  )
    return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy ? "Uploading attachment" : "Attach files"}
      disabled={disabled || busy}
      className="min-h-11 min-w-11 items-center justify-center"
      onPress={() => void upload()}
    >
      {busy ? (
        <ActivityIndicator size="small" />
      ) : (
        <SymbolView name="paperclip" size={18} tintColorClassName="accent-icon-muted" />
      )}
    </Pressable>
  );
}
