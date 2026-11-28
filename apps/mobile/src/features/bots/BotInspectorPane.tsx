import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_GALLERY,
  botAvatarFor,
} from "@t3tools/client-runtime/state/bot-avatar";
import { noteSlugFromTitle } from "@t3tools/client-runtime/state/bot-files";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_FILE_MAX_CHARS,
  type BotAvatarChoice,
  type BotAvatarShape,
  type BotFilesReadResult,
  type BotNote,
  type BotNoteSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { groupedListInsets } from "../../components/ui/listMetrics";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetPane } from "../../components/ui/SheetPane";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { botFilesEnvironment } from "../../state/botFiles";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "./BotAvatar";
import { useBotBoard } from "./useBotBoard";

type OpenNote = { readonly kind: "new" } | { readonly kind: "note"; readonly slug: string };

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  return errorDisplayMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred."));
}

function alertOnFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const message = failureMessage(result);
  if (message !== null) Dialog.alert(title, message);
}

/** A Bot's panel: its avatar, worker muting, instructions, notes and workers. */
export function BotInspectorPane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [openNote, setOpenNote] = useState<OpenNote | null>(null);
  const bot = useQuietThreadShell(props.threadRef);
  const canWrite = useAtomValue(
    botFilesEnvironment.writeNote.permissionAtom(props.threadRef.environmentId),
  );
  const files = useEnvironmentQuery(
    botFilesEnvironment.files({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    }),
  );
  // The Bot writes its memory through its own tools during a turn, which bumps nothing this
  // query reads, so each finished turn asks again.
  const turnCompletedAt = bot?.latestRun?.completedAt ?? null;
  const refreshFiles = files.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads server files the Bot changed outside this client
  useEffect(() => {
    if (turnCompletedAt !== null) refreshFiles();
  }, [turnCompletedAt, refreshFiles]);

  if (bot?.botConfig == null) return null;
  if (openNote !== null) {
    return (
      <NoteEditorPane
        threadRef={props.threadRef}
        open={openNote}
        notes={files.data?.notes ?? []}
        canWrite={canWrite}
        onClose={() => setOpenNote(null)}
      />
    );
  }
  return (
    <BotOverview
      bot={bot}
      threadRef={props.threadRef}
      files={files.data}
      filesError={files.error}
      canWrite={canWrite}
      onOpenNote={setOpenNote}
      onOpenThread={props.onOpenThread}
    />
  );
}

function PaneScroll(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <ScreenContent insetHorizontal>
      <NativeScrollView
        nestedScrollEnabled
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          ...groupedListInsets(true),
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {props.children}
      </NativeScrollView>
    </ScreenContent>
  );
}

function BotOverview(props: {
  readonly bot: EnvironmentThreadShell;
  readonly threadRef: ScopedThreadRef;
  readonly files: BotFilesReadResult | null;
  readonly filesError: string | null;
  readonly canWrite: boolean;
  readonly onOpenNote: (open: OpenNote) => void;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const setMuteChildren = useAtomCommand(threadEnvironment.setBotMuteChildren, {
    reportFailure: false,
  });
  const botConfig = props.bot.botConfig;
  return (
    <SheetPane surface="screen">
      <AppBar title={props.bot.title} />
      <PaneScroll>
        <AvatarPicker
          threadRef={props.threadRef}
          choice={botConfig?.avatar ?? null}
          canWrite={props.canWrite}
        />
        <ListSection>
          <ListToggleRow
            label={gt("Mute worker updates")}
            value={botConfig?.muteChildren ?? false}
            disabled={!props.canWrite}
            onValueChange={(muted) =>
              void setMuteChildren({
                environmentId: props.threadRef.environmentId,
                input: { threadId: props.threadRef.threadId, botMuteChildren: muted },
              }).then((result) => alertOnFailure(gt("Failed to update Bot"), result))
            }
          />
        </ListSection>
        {props.files === null ? (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {props.filesError ?? <T>Loading…</T>}
          </Text>
        ) : (
          <>
            <InstructionsSection
              key={props.files.preferences}
              threadRef={props.threadRef}
              preferences={props.files.preferences}
              canWrite={props.canWrite}
            />
            <NotesSection
              notes={props.files.notes}
              canWrite={props.canWrite}
              onOpen={props.onOpenNote}
            />
          </>
        )}
        <WorkersSection botRef={props.threadRef} onOpen={props.onOpenThread} />
      </PaneScroll>
    </SheetPane>
  );
}

function AvatarPicker(props: {
  readonly threadRef: ScopedThreadRef;
  readonly choice: BotAvatarChoice | null;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const setAvatar = useAtomCommand(threadEnvironment.setBotAvatar, { reportFailure: false });
  const current = botAvatarFor(props.threadRef.threadId, props.choice);
  const currentShape = current.definition.id as BotAvatarShape;
  const pick = (avatar: BotAvatarChoice) =>
    void setAvatar({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, botAvatar: avatar },
    }).then((result) => alertOnFailure(gt("Failed to update Bot"), result));
  return (
    <ListSection title={gt("Avatar")}>
      <View className={cn("gap-3 p-3", !props.canWrite && "opacity-45")}>
        <View className="flex-row flex-wrap gap-1">
          {BOT_AVATAR_GALLERY.map((avatar) => {
            const shape = avatar.definition.id as BotAvatarShape;
            const selected = shape === currentShape;
            return (
              <Pressable
                key={shape}
                accessibilityRole="button"
                accessibilityLabel={avatar.definition.name}
                accessibilityState={{ selected, disabled: !props.canWrite }}
                disabled={!props.canWrite}
                onPress={() => pick({ shape, color: current.color })}
                className={cn(
                  "size-11 items-center justify-center rounded-xl active:opacity-70",
                  selected && "bg-subtle-strong",
                )}
              >
                <BotAvatar
                  threadId={props.threadRef.threadId}
                  choice={{ shape, color: current.color }}
                  state="idle"
                  size={30}
                />
              </Pressable>
            );
          })}
        </View>
        <View className="flex-row flex-wrap gap-2 border-t border-separator pt-3">
          {BOT_AVATAR_COLORS.map((color) => {
            const selected = color === current.color;
            return (
              <Pressable
                key={color}
                accessibilityRole="button"
                accessibilityLabel={color}
                accessibilityState={{ selected, disabled: !props.canWrite }}
                disabled={!props.canWrite}
                hitSlop={4}
                onPress={() => pick({ shape: currentShape, color })}
                className={cn(
                  "size-8 items-center justify-center rounded-full border-2 active:opacity-70",
                  selected ? "border-foreground" : "border-transparent",
                )}
              >
                <View className="size-6 rounded-full" style={{ backgroundColor: color }} />
              </Pressable>
            );
          })}
        </View>
      </View>
    </ListSection>
  );
}

function InstructionsSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly preferences: string;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const write = useAtomCommand(botFilesEnvironment.writePreferences, { reportFailure: false });
  const [text, setText] = useState(props.preferences);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const result = await write({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, contents: text },
    });
    setSaving(false);
    alertOnFailure(gt("Failed to save Bot instructions"), result);
  };
  return (
    <ListSection
      title={gt("Instructions")}
      trailing={
        props.canWrite && text !== props.preferences ? (
          <Button
            size="compact"
            tone="text"
            label={gt("Save")}
            loading={saving}
            onPress={() => void save()}
          />
        ) : undefined
      }
    >
      <TextInput
        multiline
        editable={props.canWrite && !saving}
        accessibilityLabel={gt("Instructions")}
        placeholder={gt("How you like the Bot to work.")}
        maxLength={BOT_FILE_MAX_CHARS}
        value={text}
        onChangeText={setText}
        className="min-h-24 rounded-none border-0 bg-transparent px-4 py-3"
        style={{ textAlignVertical: "top" }}
      />
    </ListSection>
  );
}

function NotesSection(props: {
  readonly notes: ReadonlyArray<BotNoteSummary>;
  readonly canWrite: boolean;
  readonly onOpen: (open: OpenNote) => void;
}) {
  const gt = useGT();
  return (
    <ListSection
      title={gt("Notes")}
      trailing={
        props.canWrite ? (
          <Button
            size="compact"
            tone="text"
            icon="plus"
            label={gt("New note")}
            onPress={() => props.onOpen({ kind: "new" })}
          />
        ) : undefined
      }
    >
      {props.notes.length === 0 ? (
        <Text textRole="footnote" className="p-4 text-foreground-muted">
          <T>The Bot keeps its notes here.</T>
        </Text>
      ) : (
        props.notes.map((note) => (
          <ListRow
            key={note.slug}
            label={note.title}
            description={note.summary === "" ? undefined : note.summary}
            meta={
              <Text textRole="footnote" className="text-foreground-muted">
                <RelativeTime timestamp={note.updatedAt} />
              </Text>
            }
            onPress={() => props.onOpen({ kind: "note", slug: note.slug })}
          />
        ))
      )}
    </ListSection>
  );
}

const STATUS_DOT_CLASS = {
  needsYou: "bg-warning",
  working: "bg-primary",
  done: "bg-foreground-tertiary",
} as const;

function WorkersSection(props: {
  readonly botRef: ScopedThreadRef;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const [doneOpen, setDoneOpen] = useState(false);
  const { needsYou, working, done } = useBotBoard(props.botRef);
  if (needsYou.length + working.length + done.length === 0) return null;
  const rows = (status: keyof typeof STATUS_DOT_CLASS, workers: typeof done) =>
    workers.map((thread) => (
      <WorkerRow key={thread.id} thread={thread} status={status} onOpen={props.onOpen} />
    ));
  return (
    <ListSection title={gt("Workers")}>
      {rows("needsYou", needsYou)}
      {rows("working", working)}
      {done.length === 0 ? null : (
        <ListActionRow
          icon={doneOpen ? "chevron.down" : "chevron.right"}
          label={doneOpen ? gt("Done") : gt("Done · {count}", { count: done.length })}
          onPress={() => setDoneOpen(!doneOpen)}
        />
      )}
      {doneOpen ? rows("done", done) : null}
    </ListSection>
  );
}

function WorkerRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly status: keyof typeof STATUS_DOT_CLASS;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const project = useProject(scopeProjectRef(props.thread.environmentId, props.thread.projectId));
  const projectName = project?.isScratch ? gt("No project") : project?.title;
  return (
    <ListRow
      leading={<View className={cn("size-2 rounded-full", STATUS_DOT_CLASS[props.status])} />}
      label={props.thread.title}
      detail={projectName}
      onPress={() =>
        props.onOpen({ environmentId: props.thread.environmentId, threadId: props.thread.id })
      }
    />
  );
}

function NoteEditorPane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly open: OpenNote;
  readonly notes: ReadonlyArray<BotNoteSummary>;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { open } = props;
  const note = useEnvironmentQuery(
    open.kind === "note"
      ? botFilesEnvironment.note({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId, slug: open.slug },
        })
      : null,
  );
  const title = open.kind === "new" ? gt("New note") : gt("Edit note");
  if (open.kind === "note" && note.data === null) {
    return (
      <SheetPane surface="screen">
        <AppBar title={title} onBack={props.onClose} guardBack />
        <PaneScroll>
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {note.error ?? <T>Loading…</T>}
          </Text>
        </PaneScroll>
      </SheetPane>
    );
  }
  return (
    <NoteEditor
      key={open.kind === "note" ? open.slug : "new"}
      title={title}
      threadRef={props.threadRef}
      note={open.kind === "note" ? note.data : null}
      takenSlugs={new Set(props.notes.map((entry) => entry.slug))}
      canWrite={props.canWrite}
      onClose={props.onClose}
    />
  );
}

function NoteEditor(props: {
  readonly title: string;
  readonly threadRef: ScopedThreadRef;
  readonly note: BotNote | null;
  readonly takenSlugs: ReadonlySet<string>;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const writeNote = useAtomCommand(botFilesEnvironment.writeNote, { reportFailure: false });
  const deleteNote = useAtomCommand(botFilesEnvironment.deleteNote, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(props.note?.title ?? "");
  const [summary, setSummary] = useState(props.note?.summary ?? "");
  const [body, setBody] = useState(props.note?.body ?? "");
  const readOnly = !props.canWrite;
  const finish = (result: AtomCommandResult<unknown, unknown>) => {
    setBusy(false);
    const message = failureMessage(result);
    setError(message);
    if (message === null) props.onClose();
  };
  const save = async () => {
    const trimmedTitle = title.trim();
    if (trimmedTitle === "") {
      setError(gt("Give the note a title."));
      return;
    }
    setBusy(true);
    finish(
      await writeNote({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          slug: props.note?.slug ?? noteSlugFromTitle(trimmedTitle, props.takenSlugs),
          title: trimmedTitle,
          summary: summary.trim(),
          body,
        },
      }),
    );
  };
  const remove = (note: BotNote) =>
    Dialog.confirm({
      title: gt('Delete note "{title}"?', { title: note.title }),
      confirmText: gt("Delete"),
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        void deleteNote({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId, slug: note.slug },
        }).then(finish);
      },
    });
  const fieldClassName = "rounded-none border-0 bg-transparent px-4";
  return (
    <SheetPane surface="screen">
      <AppBar
        title={props.title}
        onBack={props.onClose}
        guardBack
        confirm={
          readOnly
            ? undefined
            : { label: gt("Save"), loading: busy, disabled: busy, onPress: () => void save() }
        }
      />
      <PaneScroll>
        <ListSection title={gt("Title")}>
          <TextInput
            accessibilityLabel={gt("Title")}
            editable={!readOnly && !busy}
            autoFocus={props.note === null}
            maxLength={120}
            value={title}
            onChangeText={setTitle}
            className={fieldClassName}
          />
        </ListSection>
        <ListSection title={gt("Summary")}>
          <TextInput
            accessibilityLabel={gt("Summary")}
            editable={!readOnly && !busy}
            maxLength={300}
            value={summary}
            onChangeText={setSummary}
            placeholder={gt("One line, so the Bot knows when to read it.")}
            className={fieldClassName}
          />
        </ListSection>
        <ListSection title={gt("Note")}>
          <TextInput
            multiline
            accessibilityLabel={gt("Note")}
            editable={!readOnly && !busy}
            maxLength={BOT_FILE_MAX_CHARS}
            value={body}
            onChangeText={setBody}
            className={cn(fieldClassName, "min-h-48 py-3")}
            style={{ textAlignVertical: "top" }}
          />
        </ListSection>
        {error === null ? null : (
          <Text selectable textRole="footnote" className="px-2 text-danger-foreground">
            {error}
          </Text>
        )}
        {readOnly || props.note === null ? null : (
          <ListSection>
            <ListActionRow
              icon="trash"
              tone="danger"
              label={gt("Delete note")}
              disabled={busy}
              onPress={() => {
                if (props.note !== null) remove(props.note);
              }}
            />
          </ListSection>
        )}
      </PaneScroll>
    </SheetPane>
  );
}
