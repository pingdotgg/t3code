/**
 * Saved-prompt snippet settings panel.
 *
 * Layout mirrors `KeybindingsSettings.tsx`:
 *   - One `SettingsSection` with a search box, an add button, and a count chip.
 *   - List of rows beneath, each row editing in place (via a dialog) with
 *     a small inline confirm for delete.
 *
 * Persistence is whole-map replacement on `ServerSettings.promptSnippets`
 * via `useUpdateSettings()`. The server keeps the canonical store and
 * echoes updates through the `settingsUpdated` stream, which the
 * `useServerPromptSnippets` selector picks up.
 */
import { NotebookPenIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import type { Snippet, SnippetMap } from "@t3tools/contracts";

import { useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { getServerPromptSnippets, useServerPromptSnippets } from "../../rpc/serverState";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  buildSnippetRows,
  filterSnippetRows,
  newSnippetFromDraft,
  nextSnippetId,
  normalizeSnippetId,
  replaceSnippet,
  removeSnippet,
  snippetIdList,
  updateSnippetFromDraft,
  validateSnippetDraft,
  type NewSnippetDraft,
  type SnippetDraftInput,
  type SnippetRow,
} from "./SnippetsSettings.logic";

function ExpandableHeaderSearch({
  query,
  onChange,
  isOpen,
  onOpenChange,
  inputRef,
  collapsedAccessory,
}: {
  query: string;
  onChange: (next: string) => void;
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  collapsedAccessory?: React.ReactNode;
}) {
  if (!isOpen) {
    return (
      <>
        {collapsedAccessory}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                onClick={() => onOpenChange(true)}
                aria-label="Search snippets"
              >
                <SearchIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top">Search snippets</TooltipPopup>
        </Tooltip>
      </>
    );
  }

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={() => {
          if (query.length === 0) onOpenChange(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onChange("");
            onOpenChange(false);
          }
        }}
        placeholder="Search snippets"
        aria-label="Search snippets"
        className="h-6 w-44 rounded-md border border-input bg-background pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
      />
    </div>
  );
}

interface SnippetDialogState {
  readonly mode: "create" | "edit";
  readonly snippet: Snippet | null;
}

function SnippetDialog({
  state,
  onOpenChange,
  existingIds,
}: {
  state: SnippetDialogState;
  onOpenChange: (open: boolean) => void;
  existingIds: ReadonlyArray<string>;
}) {
  const { updateSettings } = useUpdateSettings();
  const isEditing = state.mode === "edit" && state.snippet !== null;

  const [id, setId] = useState<string>("");
  const [idDirty, setIdDirty] = useState(false);
  const [title, setTitle] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  useEffect(() => {
    if (!state.snippet) {
      setId("");
      setIdDirty(false);
      setTitle("");
      setDescription("");
      setBody("");
    } else {
      setId(state.snippet.id);
      setIdDirty(true);
      setTitle(state.snippet.title);
      setDescription(state.snippet.description ?? "");
      setBody(state.snippet.body);
    }
    setHasAttemptedSubmit(false);
  }, [state.snippet]);

  const suggestedId = useMemo(() => {
    if (isEditing) return state.snippet?.id ?? "";
    return nextSnippetId(title, existingIds);
  }, [isEditing, state.snippet, title, existingIds]);

  useEffect(() => {
    if (idDirty) return;
    setId(suggestedId);
  }, [suggestedId, idDirty]);

  const errors = useMemo<ReturnType<typeof validateSnippetDraft>>(
    () =>
      validateSnippetDraft({
        id,
        title,
        description,
        body,
      } satisfies SnippetDraftInput),
    [id, title, description, body],
  );

  const showErrors = hasAttemptedSubmit;
  const idError = errors.find((error) => error.field === "id");
  const titleError = errors.find((error) => error.field === "title");
  const bodyError = errors.find((error) => error.field === "body");
  const descriptionError = errors.find((error) => error.field === "description");
  const trimmedId = id.trim();
  const idConflict = trimmedId !== state.snippet?.id && existingIds.includes(trimmedId);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setHasAttemptedSubmit(true);
      if (errors.length > 0 || idConflict) return;

      const trimmedTitle = title.trim();
      const trimmedDescription = description.trim();
      const currentSnippets = getServerPromptSnippets();

      if (state.mode === "create") {
        const draft: NewSnippetDraft = {
          id: trimmedId,
          title: trimmedTitle,
          description: trimmedDescription,
          body,
        };
        const nextSnippet = newSnippetFromDraft(draft);
        const nextMap: SnippetMap = { ...currentSnippets, [nextSnippet.id]: nextSnippet };
        updateSettings({ promptSnippets: nextMap });
        toastManager.add({
          title: "Snippet saved",
          description: `Trigger /${nextSnippet.id} will expand "${nextSnippet.title}" in the composer.`,
          type: "success",
        });
      } else if (state.snippet) {
        const updated = updateSnippetFromDraft(state.snippet, {
          id: trimmedId,
          title: trimmedTitle,
          description: trimmedDescription,
          body,
        });
        const nextMap = replaceSnippet(currentSnippets, state.snippet.id, updated);
        updateSettings({ promptSnippets: nextMap });
        toastManager.add({
          title: "Snippet updated",
          description: `Trigger /${updated.id} updated.`,
          type: "success",
        });
      }
      onOpenChange(false);
    },
    [
      body,
      description,
      errors,
      idConflict,
      onOpenChange,
      state.mode,
      state.snippet,
      title,
      trimmedId,
      updateSettings,
    ],
  );

  const trigger = isEditing ? id : id.length > 0 ? id : suggestedId;
  const preview = isEditing ? `/${trigger}` : trigger.length > 0 ? `/${trigger}` : "/(trigger)";

  return (
    <Dialog open={true} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit snippet" : "Add snippet"}</DialogTitle>
            <DialogDescription>
              Snippets expand into the composer when you select them from the{" "}
              <span className="font-mono">/</span> menu.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel scrollFade={false} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="snippet-title">Title</Label>
              <Input
                id="snippet-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.currentTarget.value);
                }}
                placeholder="Explain a stack trace"
                autoFocus
                aria-invalid={showErrors && titleError !== undefined}
              />
              {showErrors && titleError ? (
                <p className="text-xs text-destructive">{titleError.message}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="snippet-id">Trigger</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">/</span>
                <Input
                  id="snippet-id"
                  value={id}
                  onChange={(event) => {
                    setId(normalizeSnippetId(event.currentTarget.value));
                    setIdDirty(true);
                  }}
                  placeholder="explain-stack"
                  aria-invalid={showErrors && (idError !== undefined || idConflict)}
                  className="font-mono"
                />
                <span className="text-xs text-muted-foreground">{preview}</span>
              </div>
              {showErrors && (idError || idConflict) ? (
                <p className="text-xs text-destructive">
                  {idError?.message ?? "That trigger is already used by another snippet."}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground/80">
                  Lowercase letters, digits, and dashes. Up to {40} characters.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="snippet-description">Description</Label>
              <Input
                id="snippet-description"
                value={description}
                onChange={(event) => {
                  setDescription(event.currentTarget.value);
                }}
                placeholder="Optional. Shown in the slash menu."
                aria-invalid={showErrors && descriptionError !== undefined}
              />
              {showErrors && descriptionError ? (
                <p className="text-xs text-destructive">{descriptionError.message}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="snippet-body">Body</Label>
              <Textarea
                id="snippet-body"
                value={body}
                onChange={(event) => {
                  setBody(event.currentTarget.value);
                }}
                placeholder="Walk through the stack trace top-down, then suggest a fix."
                rows={6}
                className="min-h-32"
                aria-invalid={showErrors && bodyError !== undefined}
              />
              {showErrors && bodyError ? (
                <p className="text-xs text-destructive">{bodyError.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground/80">
                  Plain text. Expands verbatim into the composer.
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={showErrors && (errors.length > 0 || idConflict)}>
              {isEditing ? "Save" : "Add snippet"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteSnippetDialog({
  snippet,
  onOpenChange,
}: {
  snippet: Snippet;
  onOpenChange: (open: boolean) => void;
}) {
  const { updateSettings } = useUpdateSettings();
  const handleConfirm = useCallback(() => {
    const currentSnippets = getServerPromptSnippets();
    const nextMap = removeSnippet(currentSnippets, snippet.id);
    updateSettings({ promptSnippets: nextMap });
    toastManager.add({
      title: "Snippet removed",
      description: `Trigger /${snippet.id} no longer expands.`,
      type: "info",
    });
    onOpenChange(false);
  }, [onOpenChange, snippet.id, updateSettings]);

  return (
    <Dialog open={true} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete snippet</DialogTitle>
          <DialogDescription>
            Remove <span className="font-semibold">{snippet.title}</span> (
            <span className="font-mono">/{snippet.id}</span>)?
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <p className="text-sm text-muted-foreground">
            The trigger stops appearing in the slash menu. This cannot be undone.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SnippetRowView({
  row,
  onEdit,
  onRequestDelete,
}: {
  row: SnippetRow;
  onEdit: () => void;
  onRequestDelete: () => void;
}) {
  return (
    <div className="grid min-w-[680px] grid-cols-[minmax(180px,1.1fr)_minmax(220px,1.4fr)_88px] items-start gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <NotebookPenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[13px] font-medium text-foreground">
            {row.snippet.title}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground/80">/{row.snippet.id}</div>
        {row.snippet.description ? (
          <p className="line-clamp-1 text-xs text-muted-foreground/80">{row.snippet.description}</p>
        ) : null}
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {row.snippet.body}
      </p>
      <div className="flex items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onEdit}
                aria-label={`Edit ${row.snippet.title}`}
              >
                Edit
              </Button>
            }
          />
          <TooltipPopup side="top">Edit snippet</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                onClick={onRequestDelete}
                aria-label={`Delete ${row.snippet.title}`}
                className="size-6 rounded-sm p-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top">Delete snippet</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

export function SnippetsSettingsPanel() {
  const snippets = useServerPromptSnippets() as SnippetMap;

  const [query, setQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [dialogState, setDialogState] = useState<SnippetDialogState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Snippet | null>(null);

  const rows = useMemo(
    () => filterSnippetRows(buildSnippetRows(snippets), query),
    [snippets, query],
  );
  const existingIds = useMemo(() => snippetIdList(snippets), [snippets]);

  const handleCreate = useCallback(() => {
    setDialogState({ mode: "create", snippet: null });
  }, []);

  const handleEdit = useCallback((row: SnippetRow) => {
    setDialogState({ mode: "edit", snippet: row.snippet });
  }, []);

  const handleCloseDialog = useCallback(() => {
    setDialogState(null);
  }, []);

  const handleCloseDelete = useCallback(() => {
    setPendingDelete(null);
  }, []);

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection
        title="Snippets"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ExpandableHeaderSearch
              query={query}
              onChange={setQuery}
              isOpen={isSearchOpen}
              onOpenChange={setIsSearchOpen}
              collapsedAccessory={
                <span
                  className={cn(
                    "rounded-sm px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                    "bg-muted text-muted-foreground",
                  )}
                  aria-label={`${rows.length} snippets`}
                >
                  {rows.length} {rows.length === 1 ? "snippet" : "snippets"}
                </span>
              }
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={handleCreate}
                    aria-label="Add snippet"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add snippet</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <p className="border-b border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
          Saved prompt snippets are available across threads and environments. Trigger them in the
          composer by typing <span className="font-mono text-foreground">/</span> and picking from
          the menu, or press <span className="font-mono text-foreground">/&lt;trigger&gt;</span>{" "}
          directly.
        </p>
        <ScrollArea
          chainVerticalScroll
          scrollFade
          hideScrollbars
          className="w-full max-w-full rounded-none"
        >
          <div className="min-w-[680px] divide-y divide-border/60">
            {rows.map((row) => (
              <SnippetRowView
                key={row.snippet.id}
                row={row}
                onEdit={() => {
                  handleEdit(row);
                }}
                onRequestDelete={() => {
                  setPendingDelete(row.snippet);
                }}
              />
            ))}
            {rows.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                {query.trim().length > 0
                  ? "No snippets match your search."
                  : "No snippets saved. Click + to add one."}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </SettingsSection>
      {dialogState ? (
        <SnippetDialog
          state={dialogState}
          onOpenChange={(open) => {
            if (!open) handleCloseDialog();
          }}
          existingIds={existingIds}
        />
      ) : null}
      {pendingDelete ? (
        <DeleteSnippetDialog
          snippet={pendingDelete}
          onOpenChange={(open) => {
            if (!open) handleCloseDelete();
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
