import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_BYTES,
  boundedZip,
} from "@t3tools/client-runtime/zip/bounded-zip";
import type { EnvironmentId } from "@t3tools/contracts";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import {
  decodeFilePreviewText,
  filePreviewKind,
  hostPreviewMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import { LegendList } from "@legendapp/list/react-native";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Progress } from "../../components/ui/Progress";
import { Toolbar } from "../../components/ui/Toolbar";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import {
  nativeViewerErrorMessage,
  shareGeneratedAttachment,
  writeGeneratedAttachmentFile,
} from "../../lib/attachmentDownload";
import { attachmentDocumentPresentation } from "../../lib/attachmentDocumentPresentation";
import {
  createComposerFileAttachment,
  removePersistedComposerAttachmentFile,
} from "../../lib/composerImages";
import { appendComposerDraftAttachments } from "../../state/use-composer-drafts";
import { AttachmentDocumentBody, nativeViewerKind } from "./AttachmentDocumentBody";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import {
  buildZipTree,
  flattenZipTree,
  zipDownloadTimeLeft,
  zipFolderLabel,
  type ZipEntry,
  type ZipTreeRow,
} from "./zipTree";
import type { EntryContent } from "./ZipArchiveView";
import { addZipEntryToDraft, errorMessage } from "./ZipArchiveView";

export function ZipEntryView(props: {
  readonly archiveName: string;
  readonly entry: ZipEntry;
  readonly environmentId: EnvironmentId | null;
  readonly draftKey: string | null;
  readonly maxAttachmentBytes: number | undefined;
  readonly onBack: () => void;
}) {
  const { entry, draftKey, maxAttachmentBytes } = props;
  const { mimeType } = entry;
  const previewKind = filePreviewKind({ name: entry.name, mimeType });
  const isText = previewKind === "text" || previewKind === "markdown" || previewKind === "html";
  // Archive HTML is shown as source: a rendered page could load its sibling files.
  const kind = previewKind === "html" ? "text" : previewKind;
  const viewerKind = isText || kind === "audio" ? null : (nativeViewerKind(kind) ?? "document");
  const tooBig = entry.sizeBytes > ARCHIVE_ENTRY_MAX_BYTES;
  const [content, setContent] = useState<EntryContent>(
    tooBig
      ? {
          status: "failed",
          title: "Too big to preview",
          message: `Previews stop at ${formatAttachmentSize(ARCHIVE_ENTRY_MAX_BYTES)}. Save the file to open it in another app.`,
        }
      : { status: "loading" },
  );
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(true);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "attach" | null>(null);
  const action = useRef<AbortController | null>(null);
  const pendingViewerError = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel a pending save or attach when the entry closes.
  useEffect(() => () => action.current?.abort(), []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Write the selected entry to a cached file and release it on cleanup.
  useEffect(() => {
    if (tooBig) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void (async (): Promise<EntryContent> => {
      if (isText) return { status: "text", ...decodeFilePreviewText(entry.bytes) };
      const file = await writeGeneratedAttachmentFile({
        bytes: entry.bytes,
        attachment: { name: entry.name, mimeType },
      });
      if (controller.signal.aborted) {
        file.dispose();
        controller.signal.throwIfAborted();
      }
      release = file.dispose;
      return { status: "file", uri: file.uri };
    })()
      .then((value) => {
        if (!controller.signal.aborted) setContent(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setContent({
            status: "failed",
            title: "Couldn't read this file",
            message: errorMessage(cause, "Could not read this file."),
          });
      });
    return () => {
      controller.abort();
      release?.();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reread the entry.
  }, [entry, isText, mimeType, tooBig, revision]);

  const run = (kind: "save" | "attach", task: (signal: AbortSignal) => Promise<unknown>) => {
    if (busy) return;
    setBusy(kind);
    const controller = new AbortController();
    action.current = controller;
    void task(controller.signal).then(
      () => {
        if (controller.signal.aborted) return;
        setBusy(null);
        if (kind === "attach")
          Dialog.alert("Added to chat", `${entry.name} is attached to your message.`);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setBusy(null);
        Dialog.alert(
          kind === "save" ? "Could not save file" : "Could not add file to chat",
          errorMessage(cause, "Please try again."),
        );
      },
    );
  };
  const save = () =>
    run("save", (signal) =>
      shareGeneratedAttachment({
        bytes: entry.bytes,
        attachment: { name: entry.name, mimeType },
        signal,
      }),
    );
  const canAddToChat = draftKey !== null && maxAttachmentBytes !== undefined;
  const addToChat = () => {
    if (draftKey === null || maxAttachmentBytes === undefined) return;
    run("attach", (signal) =>
      addZipEntryToDraft({ entry, draftKey, maxBytes: maxAttachmentBytes, signal }),
    );
  };
  const openViewer = () => {
    setViewerError(null);
    setViewerOpen(true);
  };

  const text = content.status === "text" ? content : null;
  const delimiter = filePreviewDelimiter({ name: entry.name, mimeType });
  const table = text && delimiter ? parseDelimitedPreview(text.text, delimiter) : null;
  const uri = content.status === "file" ? content.uri : null;
  const { renderedMode, activeMode } = attachmentDocumentPresentation({
    kind,
    hasTable: table !== null,
    hasEnvironment: props.environmentId !== null,
    rendered,
  });
  const folders = entry.path.split("/").slice(0, -1);
  const subtitle = `${[props.archiveName, ...folders].join(" / ")} · ${formatAttachmentSize(entry.sizeBytes)}`;
  const isAndroid = Platform.OS === "android";
  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: !isAndroid,
          headerTitle: entry.name,
          title: entry.name,
          unstable_headerSubtitle: isAndroid ? undefined : subtitle,
        }}
      />
      {isAndroid ? (
        <AndroidScreenHeader
          title={entry.name}
          subtitle={subtitle}
          onBack={props.onBack}
          actions={[
            ...(renderedMode
              ? [
                  {
                    accessibilityLabel: rendered ? "Show source" : "Show preview",
                    icon: rendered ? ("doc.text" as const) : ("eye" as const),
                    onPress: () => setRendered((value) => !value),
                  },
                ]
              : []),
            ...(canAddToChat
              ? [
                  {
                    accessibilityLabel: "Add to chat",
                    icon: "plus.bubble" as const,
                    onPress: addToChat,
                    disabled: busy !== null,
                  },
                ]
              : []),
            {
              accessibilityLabel: "Save file",
              icon: "square.and.arrow.up",
              onPress: save,
              loading: busy === "save",
            },
          ]}
        />
      ) : (
        <Toolbar placement="right">
          <Toolbar.Menu accessibilityLabel="File actions" icon="ellipsis">
            {renderedMode ? (
              <Toolbar.MenuAction
                icon={rendered ? "doc.text" : "eye"}
                onPress={() => setRendered((value) => !value)}
              >
                {rendered ? "Show source" : "Show preview"}
              </Toolbar.MenuAction>
            ) : null}
            {canAddToChat ? (
              <Toolbar.MenuAction icon="plus.bubble" disabled={busy !== null} onPress={addToChat}>
                Add to chat
              </Toolbar.MenuAction>
            ) : null}
            <Toolbar.MenuAction icon="square.and.arrow.up" disabled={busy !== null} onPress={save}>
              Save file
            </Toolbar.MenuAction>
          </Toolbar.Menu>
        </Toolbar>
      )}
      {content.status === "failed" ? (
        <ScrollView contentContainerClassName="flex-grow items-center justify-center px-6">
          <EmptyState
            variant="plain"
            title={content.title}
            detail={content.message}
            action={
              <Button tone="primary" label="Save file" loading={busy === "save"} onPress={save} />
            }
          />
        </ScrollView>
      ) : viewerKind && uri && !viewerOpen ? (
        // Closing the viewer stays here so Save and Add to chat remain reachable.
        <View className="flex-1 items-center justify-center bg-sheet px-6">
          <EmptyState
            title={viewerError ? "No preview for this file" : entry.name}
            detail={viewerError ?? "Open it in the file viewer, save it, or add it to chat."}
            actionLabel="Open in file viewer"
            onAction={openViewer}
          />
        </View>
      ) : (
        <AttachmentDocumentBody
          document={{
            kind,
            activeMode,
            uri,
            content: text,
            table,
            error: null,
            needsText: isText,
            retry: () => setRevision((value) => value + 1),
            revision,
          }}
          name={entry.name}
          environmentId={props.environmentId}
          htmlRender={false}
          nativeViewer={viewerKind ? (uri ? "open" : "pending") : null}
          nativeError={null}
          onOpenNative={openViewer}
        />
      )}
      {viewerKind && uri && viewerOpen ? (
        <FilePreviewModal
          source={{ kind: viewerKind, name: entry.name, mimeType, uri }}
          onOpenError={(error) => {
            pendingViewerError.current = nativeViewerErrorMessage(error);
          }}
          onRequestClose={() => {
            setViewerError(pendingViewerError.current);
            pendingViewerError.current = null;
            setViewerOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

