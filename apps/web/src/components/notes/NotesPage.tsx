import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PlusIcon,
  StickyNoteIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { usePendingComposerFilesStore } from "../../pendingComposerFilesStore";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { filesystemEnvironment } from "../../state/filesystem";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";

/** Desktop picks the vault with the system folder dialog; elsewhere the path is typed in Settings. */
function useChooseVaultFolder(environmentId: EnvironmentId | null) {
  const update = useAtomCommand(serverEnvironment.updateSettings, "Choose notes folder");
  if (!isElectron || environmentId === null) return null;
  return async () => {
    const folder = await readLocalApi()?.dialogs.pickFolder();
    if (!folder) return;
    await update({ environmentId, input: { patch: { notesVaultPath: folder } } });
  };
}

export function NotesPage() {
  const environment = usePrimaryEnvironment();
  const settings = environment?.serverConfig?.settings;
  const chooseFolder = useChooseVaultFolder(environment?.environmentId ?? null);
  return (
    <AppRouteModal label="Notes">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel="Notes breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Notes</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {chooseFolder && settings?.notesVaultPath ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Change notes folder"
              title={`Notes folder: ${settings.notesVaultPath}`}
              onClick={() => void chooseFolder()}
            >
              <FolderOpenIcon />
            </Button>
          ) : null}
          <AppRouteModalClose />
        </header>
        {environment === null || settings === undefined ? (
          <NotesMessage title="Connect an environment to see notes." />
        ) : settings.notesVaultPath === "" ? (
          <NotesMessage
            title="No notes folder"
            description="Choose an Obsidian vault or any folder of Markdown notes on this machine."
            showSettings
            onChooseFolder={chooseFolder}
          />
        ) : (
          <NotesBrowser environmentId={environment.environmentId} />
        )}
      </div>
    </AppRouteModal>
  );
}

function NotesMessage({
  title,
  description,
  showSettings = false,
  onChooseFolder = null,
}: {
  title: string;
  description?: string | null;
  showSettings?: boolean;
  onChooseFolder?: (() => Promise<void>) | null;
}) {
  const navigate = useNavigate();
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {showSettings ? (
        <EmptyContent className="flex-row justify-center">
          {onChooseFolder ? (
            <Button onClick={() => void onChooseFolder()}>
              <FolderOpenIcon />
              Choose folder
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => void navigate({ to: "/settings/general" })}>
            Open settings
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function NotesBrowser({ environmentId }: { environmentId: EnvironmentId }) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [newNoteName, setNewNoteName] = useState<string | null>(null);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeNote = useAtomCommand(filesystemEnvironment.writeNote, "Create note");
  const searchQuery = useDebouncedValue(query.trim(), 200);
  const list = useEnvironmentQuery(
    filesystemEnvironment.listNotes({
      environmentId,
      input: searchQuery === "" ? {} : { query: searchQuery },
    }),
  );

  const createNote = async () => {
    const name = (newNoteName ?? "").trim().replace(/\.md$/i, "");
    if (name === "") return;
    const path = `${name}.md`;
    const title = name.split("/").at(-1) ?? name;
    const result = await writeNote({
      environmentId,
      input: { path, content: `# ${title}\n\n`, createOnly: true },
    });
    if (result._tag !== "Success") return;
    setNewNoteName(null);
    list.refresh();
    setSelectedPath(result.value.path);
    setEditingPath(result.value.path);
  };

  if (list.error !== null && list.data === null) {
    return <NotesMessage title="Notes unavailable" description={list.error} showSettings />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={cn(
          "flex min-h-0 w-full flex-col border-e sm:w-80 sm:shrink-0",
          selectedPath !== null && "max-sm:hidden",
        )}
      >
        <div className="flex shrink-0 flex-col gap-2 p-3">
          <div className="flex items-center gap-1.5">
            <Input
              type="search"
              size="sm"
              value={query}
              onValueChange={setQuery}
              placeholder="Search notes"
              aria-label="Search notes"
              spellCheck={false}
            />
            {canWrite ? (
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="New note"
                title="New note"
                onClick={() => setNewNoteName("")}
              >
                <PlusIcon />
              </Button>
            ) : null}
          </div>
          {newNoteName !== null ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createNote();
              }}
            >
              <Input
                size="sm"
                autoFocus
                value={newNoteName}
                onValueChange={setNewNoteName}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setNewNoteName(null);
                  }
                }}
                onBlur={() => {
                  if (newNoteName.trim() === "") setNewNoteName(null);
                }}
                placeholder="Note name, then Enter"
                aria-label="New note name"
                spellCheck={false}
              />
            </form>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {list.data === null ? (
            <div className="space-y-2 px-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : list.data.notes.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {searchQuery === "" ? "No Markdown notes in this vault." : "No matching notes."}
            </p>
          ) : (
            <ul className="px-1.5 pb-3">
              {list.data.notes.map((note) => (
                <li key={note.path}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPath(note.path);
                      setEditingPath(null);
                    }}
                    aria-current={note.path === selectedPath ? "true" : undefined}
                    className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-start hover:bg-accent aria-current:bg-accent"
                  >
                    <span className="truncate text-sm">{note.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {note.snippet ?? note.path}
                    </span>
                  </button>
                </li>
              ))}
              {list.data.truncated ? (
                <li className="px-2.5 py-2 text-xs text-muted-foreground">
                  Showing the {list.data.notes.length} most recent notes. Search to find others.
                </li>
              ) : null}
            </ul>
          )}
        </ScrollArea>
      </aside>
      <section
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          selectedPath === null && "max-sm:hidden",
        )}
      >
        {selectedPath === null ? (
          <Empty size="compact">
            <EmptyHeader>
              <StickyNoteIcon className="mb-2 size-5 text-muted-foreground" />
              <EmptyDescription>Select a note to read it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <NoteView
            key={selectedPath}
            environmentId={environmentId}
            path={selectedPath}
            canWrite={canWrite}
            editing={editingPath === selectedPath}
            onEditingChange={(editing) => setEditingPath(editing ? selectedPath : null)}
            onSaved={list.refresh}
            onBack={() => setSelectedPath(null)}
          />
        )}
      </section>
    </div>
  );
}

function NoteView({
  environmentId,
  path,
  canWrite,
  editing,
  onEditingChange,
  onSaved,
  onBack,
}: {
  environmentId: EnvironmentId;
  path: string;
  canWrite: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSaved: () => void;
  onBack: () => void;
}) {
  const note = useEnvironmentQuery(
    filesystemEnvironment.readNote({ environmentId, input: { path } }),
  );
  const writeNote = useAtomCommand(filesystemEnvironment.writeNote, "Save note");
  const addComposerFiles = usePendingComposerFilesStore((state) => state.add);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const content = draft ?? note.data?.content ?? "";

  const save = async () => {
    setSaving(true);
    const result = await writeNote({ environmentId, input: { path, content } });
    setSaving(false);
    if (result._tag !== "Success") return;
    setDraft(null);
    note.refresh();
    onSaved();
    onEditingChange(false);
  };

  const addToChat = () => {
    if (!note.data) return;
    const fileName = path.split("/").at(-1) ?? path;
    addComposerFiles([new File([note.data.content], fileName, { type: "text/markdown" })]);
    toastManager.add({ type: "success", title: `Added ${fileName} to the chat` });
  };
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 sm:px-6">
        <span className="sm:hidden">
          <Button size="icon-sm" variant="ghost" aria-label="Back to notes" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{note.data?.title ?? path}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {path}
            {note.data ? ` · ${new Date(note.data.modifiedAt).toLocaleString()}` : null}
          </p>
        </div>
        {editing ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                onEditingChange(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={saving || draft === null} onClick={() => void save()}>
              Save
            </Button>
          </>
        ) : note.data ? (
          <>
            {canWrite ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Edit note"
                title="Edit note"
                onClick={() => onEditingChange(true)}
              >
                <PencilIcon />
              </Button>
            ) : null}
            <DialogPrimitive.Close
              render={<Button size="sm" variant="outline" />}
              onClick={addToChat}
            >
              <MessageSquarePlusIcon />
              Add to chat
            </DialogPrimitive.Close>
          </>
        ) : null}
      </div>
      {editing && note.data ? (
        <textarea
          autoFocus
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              if (draft !== null) void save();
            }
          }}
          aria-label="Note content"
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-6 font-mono text-sm leading-relaxed text-foreground outline-none sm:px-8"
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8">
            {note.data ? (
              <ChatMarkdown
                text={note.data.content}
                cwd={undefined}
                environmentId={environmentId}
              />
            ) : note.error ? (
              <p className="text-sm text-muted-foreground">{note.error}</p>
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </>
  );
}
