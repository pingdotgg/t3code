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

export function isZipFile(file: { readonly name: string; readonly mimeType: string }) {
  const mime = file.mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    file.name.toLowerCase().endsWith(".zip")
  );
}

interface ZipArchive {
  readonly entries: ReadonlyArray<ZipEntry>;
  readonly fileCount: number;
}

interface ZipFailure {
  readonly title: string;
  readonly detail: string;
  readonly retry: boolean;
}

const SAVE_ZIP_HINT = "Save the ZIP to open it in another app.";
const TOO_LARGE: ZipFailure = {
  title: "Too large to browse here",
  detail: `Browsing works up to ${formatAttachmentSize(ARCHIVE_MAX_BYTES)}. ${SAVE_ZIP_HINT}`,
  retry: false,
};
const CANCELLED: ZipFailure = {
  title: "Download cancelled",
  detail: "The ZIP wasn't downloaded. Try again to list its files.",
  retry: true,
};
const NETWORK: ZipFailure = {
  title: "Couldn't download this ZIP",
  detail: "Check the connection to this environment and try again.",
  retry: true,
};

class ZipFailureError extends Error {
  constructor(readonly failure: ZipFailure) {
    super(failure.title);
  }
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

async function readArchiveBody(
  body: ReadableStream<Uint8Array>,
  onProgress: (receivedBytes: number) => void,
) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ARCHIVE_MAX_BYTES) throw new ZipFailureError(TOO_LARGE);
      chunks.push(value);
      onProgress(size);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function openArchive(bytes: ArrayBuffer): Promise<ZipArchive> {
  let files: Awaited<ReturnType<typeof boundedZip>>;
  try {
    files = await boundedZip(bytes);
  } catch (cause) {
    throw new ZipFailureError({
      title: "Couldn't browse this ZIP",
      detail: `${errorMessage(cause, "It may be incomplete or damaged.")} ${SAVE_ZIP_HINT}`,
      retry: false,
    });
  }
  const entries = [...files].map(([path, file]): ZipEntry => {
    const name = path.split("/").findLast(Boolean) ?? path;
    const dot = name.lastIndexOf(".");
    return {
      path,
      name,
      isDirectory: file.directory,
      sizeBytes: file.bytes.byteLength,
      mimeType:
        (dot > 0 ? hostPreviewMimeTypeFromExtension(name.slice(dot).toLowerCase()) : null) ??
        "application/octet-stream",
      bytes: file.bytes,
    };
  });
  return { entries, fileCount: entries.filter((entry) => !entry.isDirectory).length };
}

type ArchiveState =
  | { readonly status: "loading"; readonly receivedBytes: number; readonly timeLeft: string | null }
  | { readonly status: "ready"; readonly archive: ZipArchive }
  | { readonly status: "failed"; readonly failure: ZipFailure };

function useZipArchive(input: {
  readonly uri: string | null;
  readonly isLocal: boolean;
  readonly sizeBytes: number;
  readonly refresh: () => Promise<string | null>;
}) {
  const [state, setState] = useState<ArchiveState>({
    status: "loading",
    receivedBytes: 0,
    timeLeft: null,
  });
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const { uri, isLocal, sizeBytes } = input;
  // The parent mints a new refresh callback on every render; it must not reload the archive.
  const refresh = useEffectEvent(input.refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load archive bytes and cancel the stream on cleanup.
  useEffect(() => {
    if (!uri) return;
    const abort = new AbortController();
    controller.current = abort;
    const startedAt = Date.now();
    // oxlint-disable-next-line react/set-state-in-effect -- A new archive load resets its progress.
    setState({ status: "loading", receivedBytes: 0, timeLeft: null });
    void (async () => {
      if (sizeBytes > ARCHIVE_MAX_BYTES) throw new ZipFailureError(TOO_LARGE);
      if (isLocal) {
        const file = new File(uri);
        if ((file.size ?? 0) > ARCHIVE_MAX_BYTES) throw new ZipFailureError(TOO_LARGE);
        return openArchive(await file.arrayBuffer());
      }
      const url = (await refresh()) ?? uri;
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok || !response.body) throw new ZipFailureError(NETWORK);
      const bytes = await readArchiveBody(response.body, (receivedBytes) =>
        setState({
          status: "loading",
          receivedBytes,
          timeLeft: zipDownloadTimeLeft({
            receivedBytes,
            totalBytes: sizeBytes,
            elapsedMs: Date.now() - startedAt,
          }),
        }),
      );
      abort.signal.throwIfAborted();
      return openArchive(bytes);
    })()
      .then((archive) => {
        if (!abort.signal.aborted) setState({ status: "ready", archive });
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setState({
            status: "failed",
            failure: cause instanceof ZipFailureError ? cause.failure : NETWORK,
          });
      });
    return () => abort.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reload the archive.
  }, [uri, isLocal, sizeBytes, revision]);
  return {
    state,
    retry: () => setRevision((value) => value + 1),
    cancel: () => {
      controller.current?.abort();
      setState({ status: "failed", failure: CANCELLED });
    },
  };
}

function ZipTreeRowView(props: {
  readonly row: ZipTreeRow;
  readonly collapsed: boolean;
  readonly onToggle: (path: string) => void;
  readonly onOpen: (entry: ZipEntry) => void;
}) {
  const { node, depth } = props.row;
  const entry = node.entry;
  const folder = entry ? null : zipFolderLabel(node.label);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry ? entry.path : `${node.path} folder`}
      accessibilityState={entry ? undefined : { expanded: !props.collapsed }}
      onPress={() => (entry ? props.onOpen(entry) : props.onToggle(node.path))}
      className="mx-2 h-11 flex-row items-center gap-1.5 rounded-lg pr-2.5 active:bg-subtle"
      style={{ paddingLeft: 8 + depth * 18 }}
    >
      <View className="w-4 items-center">
        {entry ? null : (
          <SymbolView
            name={props.collapsed ? "chevron.right" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        )}
      </View>
      <View className="w-5 items-center">
        <PierreEntryIcon path={node.path} kind={entry ? "file" : "directory"} size={17} />
      </View>
      <Text className="min-w-0 flex-1 text-[15px] text-foreground" numberOfLines={1}>
        {folder ? (
          <>
            <Text className="text-[15px] text-foreground-muted">{folder.prefix}</Text>
            {folder.name}
          </>
        ) : (
          node.label
        )}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {entry
          ? formatAttachmentSize(entry.sizeBytes)
          : props.collapsed
            ? `${node.fileCount} ${node.fileCount === 1 ? "file" : "files"}`
            : ""}
      </Text>
    </Pressable>
  );
}

function ZipArchiveHeader(props: {
  readonly name: string;
  readonly subtitle: string;
  readonly tintColor: string;
  readonly onSave: () => void;
  readonly onRemove: (() => void) | null;
}) {
  const navigation = useNavigation();
  const isAndroid = Platform.OS === "android";
  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: !isAndroid,
          headerTintColor: props.tintColor,
          headerTitle: props.name,
          title: props.name,
          unstable_headerSubtitle: isAndroid ? undefined : props.subtitle,
        }}
      />
      {isAndroid ? (
        <AndroidScreenHeader
          title={props.name}
          subtitle={props.subtitle}
          onBack={() => {
            if (navigation.canGoBack()) navigation.goBack();
          }}
          actions={[
            { accessibilityLabel: "Save ZIP", icon: "square.and.arrow.up", onPress: props.onSave },
            ...(props.onRemove
              ? [
                  {
                    accessibilityLabel: "Remove from draft",
                    icon: "trash" as const,
                    onPress: props.onRemove,
                    destructive: true,
                    overflowOnly: true,
                  },
                ]
              : []),
          ]}
        />
      ) : (
        <Toolbar placement="right">
          {props.onRemove ? (
            <Toolbar.Menu accessibilityLabel="ZIP actions" icon="ellipsis">
              <Toolbar.MenuAction icon="square.and.arrow.up" onPress={props.onSave}>
                Save ZIP
              </Toolbar.MenuAction>
              <Toolbar.MenuAction icon="trash" destructive onPress={props.onRemove}>
                Remove from draft
              </Toolbar.MenuAction>
            </Toolbar.Menu>
          ) : (
            <Toolbar.Button
              accessibilityLabel="Save ZIP"
              icon="square.and.arrow.up"
              onPress={props.onSave}
            />
          )}
        </Toolbar>
      )}
    </>
  );
}

function ZipArchiveProgress(props: {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly timeLeft: string | null;
  readonly onCancel: () => void;
}) {
  const { timeLeft } = props;
  return (
    <View className="flex-1 justify-center gap-3 bg-sheet px-8">
      <Text className="text-xl font-t3-semibold text-foreground">
        {formatAttachmentSize(props.receivedBytes)}
        {props.totalBytes > 0 ? (
          <Text className="text-xl text-foreground-muted">
            {` of ${formatAttachmentSize(props.totalBytes)}`}
          </Text>
        ) : null}
      </Text>
      <Progress
        value={props.totalBytes > 0 ? props.receivedBytes / props.totalBytes : undefined}
        label="ZIP download progress"
      />
      <Text className="text-sm text-foreground-muted">
        {`Downloading the ZIP so its files can be listed.${timeLeft ? ` ${timeLeft} on this connection.` : ""}`}
      </Text>
      <Button label="Cancel" onPress={props.onCancel} />
    </View>
  );
}

function ZipArchiveFailure(props: {
  readonly failure: ZipFailure;
  readonly onRetry: () => void;
  readonly onSave: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        variant="plain"
        title={props.failure.title}
        detail={props.failure.detail}
        action={
          <View className="flex-row gap-3">
            {props.failure.retry ? (
              <Button tone="primary" label="Try again" onPress={props.onRetry} />
            ) : null}
            <Button
              tone={props.failure.retry ? "secondary" : "primary"}
              label="Save ZIP"
              onPress={props.onSave}
            />
          </View>
        }
      />
    </View>
  );
}

function ZipArchiveList(props: {
  readonly archive: ZipArchive;
  readonly headerInset: number;
  readonly onOpen: (entry: ZipEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { archive } = props;
  const rows = flattenZipTree(buildZipTree(archive.entries), collapsed, query);
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const fileCount = archive.fileCount;
  return (
    <View className="flex-1 bg-sheet">
      <LegendList
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        contentInsetStartAdjustment={props.headerInset}
        className="flex-1"
        data={rows}
        keyExtractor={(row) => `${row.node.entry ? "f" : "d"}:${row.node.path}`}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
        estimatedItemSize={44}
        recycleItems
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        extraData={collapsed}
        contentContainerStyle={{ paddingBottom: 4 }}
        ListHeaderComponent={
          <View className="px-4 pt-3 pb-2.5">
            <View className="h-[38px] flex-row items-center gap-2 rounded-[10px] bg-subtle px-3">
              <SymbolView name="magnifyingglass" size={15} tintColorClassName="accent-icon-muted" />
              <TextInput
                accessibilityLabel="Filter files in ZIP"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={`Filter ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
                placeholderTextColorClassName="accent-placeholder"
                cursorColorClassName="accent-focus"
                className="min-w-0 flex-1 font-sans text-[15px] text-foreground"
                value={query}
                onChangeText={setQuery}
              />
              {query ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear filter"
                  hitSlop={10}
                  onPress={() => setQuery("")}
                >
                  <SymbolView
                    name="xmark.circle.fill"
                    size={16}
                    tintColorClassName="accent-icon-muted"
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <ZipTreeRowView
            row={item}
            collapsed={collapsed.has(item.node.path)}
            onToggle={toggle}
            onOpen={props.onOpen}
          />
        )}
        ListEmptyComponent={
          query ? (
            <EmptyState
              variant="plain"
              title={`No files match “${query.trim()}”`}
              detail="The filter checks file names and folder paths."
              action={<Button label="Clear filter" onPress={() => setQuery("")} />}
            />
          ) : (
            <EmptyState variant="plain" title="This ZIP is empty" detail="It has no files." />
          )
        }
      />
    </View>
  );
}

export function ZipArchiveView(props: {
  readonly name: string;
  readonly subtitle: string;
  readonly tintColor: string;
  readonly sizeBytes: number;
  readonly uri: string | null;
  readonly isLocal: boolean;
  readonly refresh: () => Promise<string | null>;
  readonly environmentId: EnvironmentId | null;
  readonly draftKey: string | null;
  readonly maxAttachmentBytes: number | undefined;
  readonly onSave: () => void;
  readonly onRemove: (() => void) | null;
}) {
  const { state, retry, cancel } = useZipArchive(props);
  const [selection, setSelection] = useState<{
    readonly archive: ZipArchive;
    readonly entry: ZipEntry;
  } | null>(null);
  const archive = state.status === "ready" ? state.archive : null;
  const selected = selection && selection.archive === archive ? selection.entry : null;
  const entryOpen = selected !== null;
  usePreventRemove(entryOpen, () => setSelection(null));
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const headerInset = Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  return (
    <View className="flex-1 bg-sheet">
      {entryOpen ? null : (
        <ZipArchiveHeader
          name={props.name}
          subtitle={
            archive
              ? `${archive.fileCount} ${archive.fileCount === 1 ? "file" : "files"}${props.sizeBytes > 0 ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}`
              : props.subtitle
          }
          tintColor={props.tintColor}
          onSave={props.onSave}
          onRemove={props.onRemove}
        />
      )}
      {state.status === "ready" ? (
        <ZipArchiveList
          archive={state.archive}
          headerInset={headerInset}
          onOpen={(entry) => {
            Keyboard.dismiss();
            setSelection({ archive: state.archive, entry });
          }}
        />
      ) : (
        <View className="flex-1" style={{ paddingTop: headerInset }}>
          {state.status === "loading" ? (
            props.isLocal || state.receivedBytes === 0 ? (
              <FilePreviewLoading message="Opening ZIP..." />
            ) : (
              <ZipArchiveProgress
                receivedBytes={state.receivedBytes}
                totalBytes={props.sizeBytes}
                timeLeft={state.timeLeft}
                onCancel={cancel}
              />
            )
          ) : (
            <ZipArchiveFailure failure={state.failure} onRetry={retry} onSave={props.onSave} />
          )}
        </View>
      )}
      {selected ? (
        <View className="absolute inset-0">
          <ZipEntryView
            key={selected.path}
            archiveName={props.name}
            entry={selected}
            environmentId={props.environmentId}
            draftKey={props.draftKey}
            maxAttachmentBytes={props.maxAttachmentBytes}
            onBack={() => setSelection(null)}
          />
        </View>
      ) : null}
    </View>
  );
}

async function addZipEntryToDraft(input: {
  readonly entry: ZipEntry;
  readonly draftKey: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}) {
  const { entry, signal } = input;
  const file = await writeGeneratedAttachmentFile({
    bytes: entry.bytes,
    attachment: { name: entry.name, mimeType: entry.mimeType },
  });
  try {
    signal.throwIfAborted();
    const attachment = await createComposerFileAttachment({
      uri: file.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      maxBytes: input.maxBytes,
    });
    if (signal.aborted) {
      await removePersistedComposerAttachmentFile(attachment.fileUri);
      signal.throwIfAborted();
    }
    // Rejected attachments are cleaned up by the draft store.
    if (appendComposerDraftAttachments(input.draftKey, [attachment], { appendReference: true }))
      throw new Error("This message already has as many attachments as it can hold.");
  } finally {
    file.dispose();
  }
}

type EntryContent =
  | { readonly status: "loading" }
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "file"; readonly uri: string }
  | { readonly status: "failed"; readonly title: string; readonly message: string };

function ZipEntryView(props: {
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
