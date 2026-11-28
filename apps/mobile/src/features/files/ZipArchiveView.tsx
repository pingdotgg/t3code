import { FilePasswordPrompt } from "./FilePasswordPrompt";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_BYTES,
  boundedZip,
} from "@t3tools/client-runtime/zip/bounded-zip";
import { isZipError } from "@t3tools/client-runtime/zip/error";
import { zipErrorText } from "@t3tools/client-runtime/zip/error-messages";
import type { EnvironmentId } from "@t3tools/contracts";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import {
  decodeFilePreviewText,
  filePreviewKind,
  hostPreviewMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import { LegendList } from "@legendapp/list/react-native";
import * as Schema from "effect/Schema";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, TextInput, View } from "react-native";

import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppBar } from "../../components/ui/AppBar";
import { useContentBottomInset, useContentTopInset } from "../../components/ui/useBarInset";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Progress } from "../../components/ui/Progress";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal } from "../../components/ui/FilePreviewModal";
import { m } from "../../i18n/messages";
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

// title and detail hold msg() strings; they resolve where they render.
const ZipFailure = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
  retry: Schema.Boolean,
});
type ZipFailure = typeof ZipFailure.Type;

const TOO_LARGE: ZipFailure = {
  title: msg("Too large to browse here"),
  detail: msg("Browsing works up to {size}. Save the ZIP to open it in another app.", {
    size: formatAttachmentSize(ARCHIVE_MAX_BYTES),
  }),
  retry: false,
};
const CANCELLED: ZipFailure = {
  title: msg("Download cancelled"),
  detail: msg("The ZIP wasn't downloaded. Try again to list its files."),
  retry: true,
};
const NETWORK: ZipFailure = {
  title: msg("Couldn't download this ZIP"),
  detail: msg("Check the connection to this environment and try again."),
  retry: true,
};

class ZipFailureError extends Schema.TaggedError<ZipFailureError>()("ZipFailureError", {
  failure: ZipFailure,
}) {
  override get message(): string {
    return m(this.failure.title);
  }
}

const isZipFailureError = Schema.is(ZipFailureError);

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? (errorDisplayMessage(cause, m) ?? cause.message) : fallback;
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
      if (size > ARCHIVE_MAX_BYTES) throw new ZipFailureError({ failure: TOO_LARGE });
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

async function openArchive(bytes: ArrayBuffer, signal: AbortSignal, password?: string) {
  let files: Awaited<ReturnType<typeof boundedZip>>;
  try {
    files = await boundedZip(bytes, ARCHIVE_MAX_BYTES, { password, signal });
  } catch (cause) {
    if (
      isZipError(cause) &&
      (cause.code === "password-required" || cause.code === "password-incorrect")
    )
      return { status: "locked", bytes, incorrect: cause.code === "password-incorrect" } as const;
    throw new ZipFailureError({
      failure: {
        title: msg("Couldn't browse this ZIP"),
        detail:
          cause instanceof Error
            ? msg("{error} Save the ZIP to open it in another app.", {
                error: isZipError(cause) ? zipErrorText(cause.code, m) : cause.message,
              })
            : msg("It may be incomplete or damaged. Save the ZIP to open it in another app."),
        retry: false,
      },
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
  const archive: ZipArchive = {
    entries,
    fileCount: entries.filter((entry) => !entry.isDirectory).length,
  };
  return { status: "ready", archive } as const;
}

type ArchiveState =
  | { readonly status: "loading"; readonly receivedBytes: number; readonly timeLeft: string | null }
  | Awaited<ReturnType<typeof openArchive>>
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
      if (sizeBytes > ARCHIVE_MAX_BYTES) throw new ZipFailureError({ failure: TOO_LARGE });
      if (isLocal) {
        const file = new File(uri);
        if ((file.size ?? 0) > ARCHIVE_MAX_BYTES) throw new ZipFailureError({ failure: TOO_LARGE });
        return openArchive(await file.arrayBuffer(), abort.signal);
      }
      const url = (await refresh()) ?? uri;
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok || !response.body) throw new ZipFailureError({ failure: NETWORK });
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
      return openArchive(bytes, abort.signal);
    })()
      .then((result) => {
        if (!abort.signal.aborted) setState(result);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setState({
            status: "failed",
            failure: isZipFailureError(cause) ? cause.failure : NETWORK,
          });
      });
    return () => abort.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reload the archive.
  }, [uri, isLocal, sizeBytes, revision]);
  return {
    state,
    unlock: (password: string) => {
      const signal = controller.current?.signal;
      if (state.status !== "locked" || !signal || signal.aborted) return;
      setState({ status: "loading", receivedBytes: 0, timeLeft: null });
      void openArchive(state.bytes, signal, password).then(
        (result) => {
          if (!signal.aborted) setState(result);
        },
        (cause: unknown) => {
          if (!signal.aborted)
            setState({
              status: "failed",
              failure: isZipFailureError(cause) ? cause.failure : NETWORK,
            });
        },
      );
    },
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
  const gt = useGT();
  const messages = useMessages();
  const folder = entry ? null : zipFolderLabel(node.label);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry ? entry.path : gt("{path} folder", { path: node.path })}
      accessibilityState={entry ? undefined : { expanded: !props.collapsed }}
      onPress={() => (entry ? props.onOpen(entry) : props.onToggle(node.path))}
      className="mx-2 min-h-[44px] flex-row items-center gap-1.5 rounded-lg pr-2.5 active:bg-subtle android:min-h-[48px]"
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
          ? formatAttachmentSize(entry.sizeBytes, messages)
          : props.collapsed
            ? gt("{count, plural, one {{count} file} other {{count} files}}", {
                count: node.fileCount,
              })
            : ""}
      </Text>
    </Pressable>
  );
}

function ZipArchiveHeader(props: {
  readonly name: string;
  readonly subtitle: string;
  readonly onSave: () => void;
  readonly onRemove: (() => void) | null;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  return (
    <AppBar
      title={props.name}
      subtitle={props.subtitle}
      onBack={() => {
        if (navigation.canGoBack()) navigation.goBack();
      }}
      actions={[
        { accessibilityLabel: gt("Save ZIP"), icon: "square.and.arrow.up", onPress: props.onSave },
        ...(props.onRemove
          ? [
              {
                accessibilityLabel: gt("Remove from draft"),
                icon: "trash" as const,
                onPress: props.onRemove,
                destructive: true,
                overflowOnly: true,
              },
            ]
          : []),
      ]}
    />
  );
}

function ZipArchiveProgress(props: {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly timeLeft: string | null;
  readonly onCancel: () => void;
}) {
  const { timeLeft } = props;
  const gt = useGT();
  const messages = useMessages();
  return (
    <View className="flex-1 justify-center gap-3 bg-sheet px-8">
      <Text className="text-xl font-t3-semibold text-foreground">
        {props.totalBytes > 0 ? (
          <T>
            <Var>{formatAttachmentSize(props.receivedBytes, messages)}</Var>
            <Text className="text-xl text-foreground-muted">
              {" "}
              of <Var>{formatAttachmentSize(props.totalBytes, messages)}</Var>
            </Text>
          </T>
        ) : (
          formatAttachmentSize(props.receivedBytes, messages)
        )}
      </Text>
      <Progress
        value={props.totalBytes > 0 ? props.receivedBytes / props.totalBytes : undefined}
        label={gt("ZIP download progress")}
      />
      <Text className="text-sm text-foreground-muted">
        {timeLeft
          ? gt("Downloading the ZIP so its files can be listed. {timeLeft} on this connection.", {
              timeLeft,
            })
          : gt("Downloading the ZIP so its files can be listed.")}
      </Text>
      <Button label={gt("Cancel")} onPress={props.onCancel} />
    </View>
  );
}

function ZipArchiveFailure(props: {
  readonly failure: ZipFailure;
  readonly onRetry: () => void;
  readonly onSave: () => void;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <EmptyState
        variant="plain"
        title={resolveMessage(props.failure.title)}
        detail={resolveMessage(props.failure.detail)}
        action={
          <View className="flex-row gap-3">
            {props.failure.retry ? (
              <Button tone="primary" label={gt("Try again")} onPress={props.onRetry} />
            ) : null}
            <Button
              tone={props.failure.retry ? "secondary" : "primary"}
              label={gt("Save ZIP")}
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
  const gt = useGT();
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
  const bottomInset = useContentBottomInset();
  return (
    <View className="flex-1 bg-sheet">
      <LegendList
        renderScrollComponent={NativeScrollView}
        contentInset={{ top: props.headerInset, bottom: bottomInset }}
        className="flex-1"
        data={rows}
        keyExtractor={(row) => `${row.node.entry ? "f" : "d"}:${row.node.path}`}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustsScrollIndicatorInsets
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
                accessibilityLabel={gt("Filter files in ZIP")}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={gt(
                  "{count, plural, one {Filter {count} file} other {Filter {count} files}}",
                  { count: fileCount },
                )}
                placeholderTextColorClassName="accent-placeholder"
                cursorColorClassName="accent-focus"
                className="min-w-0 flex-1 font-sans text-[15px] text-foreground"
                value={query}
                onChangeText={setQuery}
              />
              {query ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("Clear filter")}
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
              title={gt("No files match “{query}”", { query: query.trim() })}
              detail={gt("The filter checks file names and folder paths.")}
              action={<Button label={gt("Clear filter")} onPress={() => setQuery("")} />}
            />
          ) : (
            <EmptyState
              variant="plain"
              title={gt("This ZIP is empty")}
              detail={gt("It has no files.")}
            />
          )
        }
      />
    </View>
  );
}

export function ZipArchiveView(props: {
  readonly name: string;
  readonly subtitle: string;
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
  const { state, unlock, retry, cancel } = useZipArchive(props);
  const gt = useGT();
  const messages = useMessages();
  const [selection, setSelection] = useState<{
    readonly archive: ZipArchive;
    readonly entry: ZipEntry;
  } | null>(null);
  const archive = state.status === "ready" ? state.archive : null;
  const selected = selection && selection.archive === archive ? selection.entry : null;
  const entryOpen = selected !== null;
  usePreventRemove(entryOpen, () => setSelection(null));
  const headerInset = useContentTopInset();
  return (
    <View className="flex-1 bg-sheet">
      {entryOpen ? null : (
        <ZipArchiveHeader
          name={props.name}
          subtitle={
            archive
              ? props.sizeBytes > 0
                ? gt(
                    "{count, plural, one {{count} file · {size}} other {{count} files · {size}}}",
                    {
                      count: archive.fileCount,
                      size: formatAttachmentSize(props.sizeBytes, messages),
                    },
                  )
                : gt("{count, plural, one {{count} file} other {{count} files}}", {
                    count: archive.fileCount,
                  })
              : props.subtitle
          }
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
              <FilePreviewLoading message={gt("Opening ZIP...")} />
            ) : (
              <ZipArchiveProgress
                receivedBytes={state.receivedBytes}
                totalBytes={props.sizeBytes}
                timeLeft={state.timeLeft}
                onCancel={cancel}
              />
            )
          ) : state.status === "locked" ? (
            <FilePasswordPrompt incorrect={state.incorrect} onSubmit={unlock} />
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
      throw new Error(m(msg("This message already has as many attachments as it can hold.")));
  } finally {
    file.dispose();
  }
}

type EntryContent =
  | { readonly status: "loading" }
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "file"; readonly uri: string }
  | {
      readonly status: "failed";
      readonly reason: "tooBig" | "unreadable";
      readonly detail: string | null;
    };

function ZipEntryView(props: {
  readonly archiveName: string;
  readonly entry: ZipEntry;
  readonly environmentId: EnvironmentId | null;
  readonly draftKey: string | null;
  readonly maxAttachmentBytes: number | undefined;
  readonly onBack: () => void;
}) {
  const { entry, draftKey, maxAttachmentBytes } = props;
  const gt = useGT();
  const messages = useMessages();
  const { mimeType } = entry;
  const previewKind = filePreviewKind({ name: entry.name, mimeType });
  const isText = previewKind === "text" || previewKind === "markdown" || previewKind === "html";
  // Archive HTML is shown as source: a rendered page could load its sibling files.
  const kind = previewKind === "html" ? "text" : previewKind;
  const viewerKind = isText || kind === "audio" ? null : (nativeViewerKind(kind) ?? "document");
  const tooBig = entry.sizeBytes > ARCHIVE_ENTRY_MAX_BYTES;
  const [content, setContent] = useState<EntryContent>(
    tooBig ? { status: "failed", reason: "tooBig", detail: null } : { status: "loading" },
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
            reason: "unreadable",
            detail:
              cause instanceof Error ? (errorDisplayMessage(cause, m) ?? cause.message) : null,
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
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setBusy(null);
        Dialog.alert(
          kind === "save" ? m(msg("Could not save file")) : m(msg("Could not add file to chat")),
          errorMessage(cause, m(msg("Please try again."))),
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
  const subtitle = `${[props.archiveName, ...folders].join(" / ")} · ${formatAttachmentSize(entry.sizeBytes, messages)}`;
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={entry.name}
        subtitle={subtitle}
        onBack={props.onBack}
        menus={[
          {
            title: gt("File actions"),
            icon: "ellipsis",
            items: [
              ...(renderedMode
                ? [
                    {
                      id: "toggle-rendered",
                      title: rendered ? gt("Show source") : gt("Show preview"),
                      icon: rendered ? "doc.text" : "eye",
                      onPress: () => setRendered((value) => !value),
                    },
                  ]
                : []),
              ...(canAddToChat
                ? [
                    {
                      id: "add-to-chat",
                      title: gt("Add to chat"),
                      icon: "plus.bubble",
                      disabled: busy !== null,
                      onPress: addToChat,
                    },
                  ]
                : []),
              {
                id: "save",
                title: gt("Save file"),
                icon: "square.and.arrow.up",
                disabled: busy !== null,
                onPress: save,
              },
            ],
          },
        ]}
      />
      {content.status === "failed" ? (
        <ScrollView contentContainerClassName="flex-grow items-center justify-center px-6">
          <EmptyState
            variant="plain"
            title={
              content.reason === "tooBig" ? gt("Too big to preview") : gt("Couldn't read this file")
            }
            detail={
              content.reason === "tooBig"
                ? gt("Previews stop at {size}. Save the file to open it in another app.", {
                    size: formatAttachmentSize(ARCHIVE_ENTRY_MAX_BYTES, messages),
                  })
                : (content.detail ?? gt("Could not read this file."))
            }
            action={
              <Button
                tone="primary"
                label={gt("Save file")}
                loading={busy === "save"}
                onPress={save}
              />
            }
          />
        </ScrollView>
      ) : viewerKind && uri && !viewerOpen ? (
        // Closing the viewer stays here so Save and Add to chat remain reachable.
        <View className="flex-1 items-center justify-center bg-sheet px-6">
          <EmptyState
            title={viewerError ? gt("No preview for this file") : entry.name}
            detail={viewerError ?? gt("Open it in the file viewer, save it, or add it to chat.")}
            actionLabel={gt("Open in file viewer")}
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
