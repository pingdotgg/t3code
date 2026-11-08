import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, StickyNoteIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
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
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";

export function NotesPage() {
  const environment = usePrimaryEnvironment();
  const settings = environment?.serverConfig?.settings;
  return (
    <AppRouteModal label="Notes">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel="Notes breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Notes</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <AppRouteModalClose />
        </header>
        {environment === null || settings === undefined ? (
          <NotesMessage title="Connect an environment to see notes." />
        ) : settings.notesVaultPath === "" ? (
          <NotesMessage
            title="No vault folder"
            description="Choose the folder of Markdown notes on this environment's machine."
            showSettings
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
}: {
  title: string;
  description?: string | null;
  showSettings?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {showSettings ? (
        <EmptyContent>
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
  const searchQuery = useDebouncedValue(query.trim(), 200);
  const list = useEnvironmentQuery(
    filesystemEnvironment.listNotes({
      environmentId,
      input: searchQuery === "" ? {} : { query: searchQuery },
    }),
  );

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
        <div className="shrink-0 p-3">
          <Input
            type="search"
            size="sm"
            value={query}
            onValueChange={setQuery}
            placeholder="Search notes"
            aria-label="Search notes"
            spellCheck={false}
          />
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
                    onClick={() => setSelectedPath(note.path)}
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
            environmentId={environmentId}
            path={selectedPath}
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
  onBack,
}: {
  environmentId: EnvironmentId;
  path: string;
  onBack: () => void;
}) {
  const note = useEnvironmentQuery(
    filesystemEnvironment.readNote({ environmentId, input: { path } }),
  );
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
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8">
          {note.data ? (
            <ChatMarkdown text={note.data.content} cwd={undefined} environmentId={environmentId} />
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
    </>
  );
}
