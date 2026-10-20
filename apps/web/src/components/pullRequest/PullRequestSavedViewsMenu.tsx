import { BookmarkIcon, CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  PULL_REQUEST_VIEW_NAME_MAX_LENGTH,
  pullRequestViewNameError,
} from "@t3tools/client-runtime/pull-request-saved-views";

import { getLocalStorageItem, useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
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
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  pullRequestListPreferences,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";
import {
  EMPTY_PULL_REQUEST_SAVED_VIEWS,
  PULL_REQUEST_SAVED_VIEWS_KEY,
  PullRequestSavedViews,
  pullRequestViewMatches,
  type PullRequestSavedView,
} from "./pullRequestSavedViews";

export function PullRequestSavedViewsMenu({
  preferences,
  onApply,
}: {
  preferences: PullRequestListPreferences;
  onApply: (preferences: PullRequestListPreferences) => void;
}) {
  const [views, setViews] = useLocalStorage(
    PULL_REQUEST_SAVED_VIEWS_KEY,
    EMPTY_PULL_REQUEST_SAVED_VIEWS,
    PullRequestSavedViews,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id?: string; name: string } | null>(null);
  const inputId = useId();
  const errorId = useId();
  const selectedView =
    views.find((view) => view.id === selectedId) ??
    views.find((view) => pullRequestViewMatches(view, preferences));
  const modified = selectedView !== undefined && !pullRequestViewMatches(selectedView, preferences);
  const nameError = editor ? pullRequestViewNameError(editor.name, views, editor.id) : null;

  function persist(
    update: (current: ReadonlyArray<PullRequestSavedView>) => ReadonlyArray<PullRequestSavedView>,
  ) {
    let written: ReadonlyArray<PullRequestSavedView> | undefined;
    setViews((current) => {
      written = update(current);
      return written;
    });
    // The shared hook logs storage failures. Keep the editor open and explain when saving failed.
    try {
      if (
        written &&
        JSON.stringify(getLocalStorageItem(PULL_REQUEST_SAVED_VIEWS_KEY, PullRequestSavedViews)) ===
          JSON.stringify(written)
      ) {
        return true;
      }
    } catch {
      // A browser policy can deny reads as well as writes.
    }
    toastManager.add({
      type: "error",
      title: "Could not save PR views",
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
        : [...current, { id, name, preferences: pullRequestListPreferences(preferences) }];
    });
    if (missing) {
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
                aria-label="Saved pull request views"
              />
            }
          >
            <BookmarkIcon aria-hidden className="size-4" />
            <span className="max-w-40 truncate">{selectedView?.name ?? "Views"}</span>
            {modified ? <span aria-label="Modified view">*</span> : null}
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </TooltipTrigger>
          <TooltipPopup>{selectedView?.name ?? "Saved pull request views"}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start">
          {views.map((view) => (
            <Tooltip key={view.id}>
              <TooltipTrigger
                render={
                  <MenuItem
                    onClick={() => {
                      setSelectedId(view.id);
                      onApply(pullRequestListPreferences(view.preferences));
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
          <MenuItem
            onClick={() =>
              setEditor({
                name: preferences.involvement === "reviewing" ? "PRs Requesting My Review" : "",
              })
            }
          >
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
                          ? { ...view, preferences: pullRequestListPreferences(preferences) }
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
              <DialogTitle>{editor?.id ? "Rename PR view" : "Save PR view"}</DialogTitle>
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
                  maxLength={PULL_REQUEST_VIEW_NAME_MAX_LENGTH}
                  placeholder="PRs Requesting My Review"
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
