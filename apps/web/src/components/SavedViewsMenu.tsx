import { BookmarkIcon, CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import type * as Schema from "effect/Schema";
import {
  SAVED_VIEW_NAME_MAX_LENGTH,
  savedViewNameError,
} from "@t3tools/client-runtime/saved-views";

import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SavedView<Preferences> {
  readonly id: string;
  readonly name: string;
  readonly preferences: Preferences;
}

/**
 * What one list (pull requests, issues) stores and how it compares its list controls. `Stored`
 * is the schema's decoded shape, which may spell absent fields as `undefined`.
 */
export interface SavedViewsKind<Preferences extends Stored, Stored, Encoded> {
  readonly storageKey: string;
  readonly schema: Schema.Codec<ReadonlyArray<SavedView<Stored>>, Encoded>;
  readonly empty: ReadonlyArray<SavedView<Stored>>;
  /** "pull request" in the menu's label, "PR" in the dialog and errors. */
  readonly noun: string;
  readonly shortNoun: string;
  readonly placeholder: string;
  readonly suggestedName: (preferences: Preferences) => string;
  /** Drops the parts of the list state that a view does not keep. */
  readonly normalize: (preferences: Stored) => Preferences;
  readonly matches: (view: SavedView<Stored>, preferences: Preferences) => boolean;
}

export function SavedViewsMenu<Preferences extends Stored, Stored, Encoded>({
  kind,
  preferences,
  onApply,
}: {
  kind: SavedViewsKind<Preferences, Stored, Encoded>;
  preferences: Preferences;
  onApply: (preferences: Preferences) => void;
}) {
  const [views, setViews] = useLocalStorage(kind.storageKey, kind.empty, kind.schema);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id?: string; name: string } | null>(null);
  const inputId = useId();
  const errorId = useId();
  const selectedView =
    views.find((view) => view.id === selectedId) ??
    views.find((view) => kind.matches(view, preferences));
  if (selectedView && selectedId !== selectedView.id) setSelectedId(selectedView.id);
  const modified = selectedView !== undefined && !kind.matches(selectedView, preferences);
  const nameError = editor ? savedViewNameError(editor.name, views, editor.id) : null;

  function persist(
    update: (current: ReadonlyArray<SavedView<Stored>>) => ReadonlyArray<SavedView<Stored>>,
  ) {
    let written: ReadonlyArray<SavedView<Stored>> | undefined;
    setViews((current) => {
      written = update(current);
      return written;
    });
    // The shared hook logs storage failures. Keep the editor open and explain when saving failed.
    try {
      if (
        written &&
        JSON.stringify(getLocalStorageItem(kind.storageKey, kind.schema)) ===
          JSON.stringify(written)
      ) {
        return true;
      }
    } catch {
      // A browser policy can deny reads as well as writes.
    }
    toastManager.add({
      type: "error",
      title: `Could not save ${kind.shortNoun} views`,
      description:
        "Local storage is unavailable or full. Try again after freeing space or allowing storage.",
    });
    return false;
  }

  function saveName() {
    if (!editor || nameError) return;
    const id = editor.id ?? randomUUID();
    const name = editor.name.trim();
    const editingId = editor.id;
    let missing = false;
    const saved = persist((current) => {
      if (editingId && !current.some((view) => view.id === editingId)) {
        missing = true;
        return current;
      }
      return editingId
        ? current.map((view) => (view.id === editingId ? { ...view, name } : view))
        : [...current, { id, name, preferences: kind.normalize(preferences) }];
    });
    if (missing) {
      setEditor((current) => (current ? { name: current.name } : null));
      toastManager.add({
        type: "error",
        title: "This saved view was removed",
        description: "Your name has been kept. Save it as a new view or cancel.",
      });
      return;
    }
    if (!saved) return;
    setSelectedId(id);
    setEditor(null);
  }

  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button variant="outline" />}
                aria-label={`Saved ${kind.noun} views`}
              />
            }
          >
            <BookmarkIcon aria-hidden className="size-4" />
            <span className="max-w-40 truncate">{selectedView?.name ?? "Views"}</span>
            {modified ? <span aria-label="Modified view">*</span> : null}
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </TooltipTrigger>
          <TooltipPopup>{selectedView?.name ?? `Saved ${kind.noun} views`}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start">
          {views.map((view) => (
            <Tooltip key={view.id}>
              <TooltipTrigger
                render={
                  <MenuItem
                    onClick={() => {
                      setSelectedId(view.id);
                      onApply(kind.normalize(view.preferences));
                    }}
                  />
                }
              >
                {selectedView?.id === view.id && !modified ? (
                  <CheckIcon aria-hidden />
                ) : (
                  <BookmarkIcon aria-hidden />
                )}
                <MenuItemLabel>{view.name}</MenuItemLabel>
              </TooltipTrigger>
              <TooltipPopup side="right">{view.name}</TooltipPopup>
            </Tooltip>
          ))}
          {views.length > 0 ? <MenuSeparator /> : null}
          <MenuItem onClick={() => setEditor({ name: kind.suggestedName(preferences) })}>
            <PlusIcon aria-hidden />
            Save current view…
          </MenuItem>
          {selectedView ? (
            <>
              {modified ? (
                <MenuItem
                  onClick={() =>
                    persist((current) =>
                      current.map((view) =>
                        view.id === selectedView.id
                          ? { ...view, preferences: kind.normalize(preferences) }
                          : view,
                      ),
                    )
                  }
                >
                  Update saved view
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => setEditor({ id: selectedView.id, name: selectedView.name })}>
                Rename view…
              </MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() => {
                  if (persist((current) => current.filter((view) => view.id !== selectedView.id)))
                    setSelectedId(null);
                }}
              >
                Delete view
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogPopup>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              saveName();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editor?.id ? `Rename ${kind.shortNoun} view` : `Save ${kind.shortNoun} view`}
              </DialogTitle>
              <DialogDescription>
                Save your search, filters, and sort order on this device.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-2">
                <Label htmlFor={inputId}>View name</Label>
                <Input
                  id={inputId}
                  autoFocus
                  value={editor?.name ?? ""}
                  maxLength={SAVED_VIEW_NAME_MAX_LENGTH}
                  placeholder={kind.placeholder}
                  aria-invalid={Boolean(editor?.name && nameError)}
                  aria-describedby={nameError && editor?.name ? errorId : undefined}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, name: event.target.value } : null,
                    )
                  }
                />
                {nameError && editor?.name ? (
                  <p id={errorId} className="text-sm text-destructive-foreground">
                    {nameError}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditor(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={nameError !== null}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
