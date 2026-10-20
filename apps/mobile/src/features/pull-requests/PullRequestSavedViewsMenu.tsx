import { pullRequestViewNameError } from "@t3tools/client-runtime/pull-request-saved-views";
import { useState } from "react";
import { Alert } from "react-native";

import { prompt as showTextInputDialog } from "../../components/ui/Dialog";
import type { MenuProps } from "../../components/ui/Menu.types";
import { uuidv4 } from "../../lib/uuid";
import type { PullRequestSavedView } from "../../persistence/mobile-preferences";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { pullRequestViewMatches, type PullRequestSavedViewScope } from "./pullRequestSavedViews";
import { usePullRequestSavedViews } from "./usePullRequestListControls";

export function PullRequestSavedViewsMenu({
  scope,
  onApply,
}: {
  scope: PullRequestSavedViewScope;
  onApply: (view: PullRequestSavedView) => Promise<void>;
}) {
  const { views, ready, update } = usePullRequestSavedViews();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedView =
    views.find((view) => view.id === selectedId) ??
    views.find((view) => pullRequestViewMatches(view, scope));
  if (selectedId === null && selectedView) setSelectedId(selectedView.id);
  const modified = selectedView !== undefined && !pullRequestViewMatches(selectedView, scope);

  async function applyView(view: PullRequestSavedView) {
    setBusy(true);
    try {
      await onApply(view);
      setSelectedId(view.id);
    } catch {
      Alert.alert("Could not apply PR view", "The device could not save your filters. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function persist(
    transform: (
      current: ReadonlyArray<PullRequestSavedView>,
    ) => ReadonlyArray<PullRequestSavedView>,
  ) {
    setBusy(true);
    try {
      await update(transform);
      return true;
    } catch {
      Alert.alert("Could not save PR views", "The device could not save your views. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function editName(view?: PullRequestSavedView) {
    showTextInputDialog({
      title: view ? "Rename PR view" : "Save PR view",
      initialValue:
        view?.name ??
        (scope.controls.involvement === "reviewing" ? "PRs Requesting My Review" : ""),
      confirmText: "Save",
      onConfirm: (value) => {
        const error = pullRequestViewNameError(value, views, view?.id);
        if (error) {
          Alert.alert("Could not save view", error);
          return;
        }
        const id = view?.id ?? uuidv4();
        const name = value.trim();
        void persist((current) =>
          view
            ? current.map((item) => (item.id === view.id ? { ...item, name } : item))
            : [...current, { ...scope, id, name }],
        ).then((saved) => {
          if (saved) setSelectedId(id);
        });
      },
    });
  }

  const actions: MenuProps["actions"] = [
    ...views.map((view) => ({
      id: `apply:${view.id}`,
      title: view.name,
      state: selectedView?.id === view.id && !modified ? ("on" as const) : ("off" as const),
    })),
    { id: "save", title: "Save current view…" },
    ...(selectedView
      ? [
          ...(modified ? [{ id: "update", title: "Update saved view" }] : []),
          { id: "rename", title: "Rename view…" },
          { id: "delete", title: "Delete view", attributes: { destructive: true } },
        ]
      : []),
  ];

  return (
    <ListFilterMenu
      label={selectedView ? `${selectedView.name}${modified ? " *" : ""}` : "Views"}
      active={selectedView !== undefined}
      accessibilityLabel="Saved pull request views"
      actions={actions.map((action) => ({
        ...action,
        attributes: { ...action.attributes, disabled: !ready || busy },
      }))}
      onSelect={(id) => {
        if (!ready || busy) return;
        const view = views.find((item) => `apply:${item.id}` === id);
        if (view) {
          void applyView(view);
          return;
        }
        if (id === "save") editName();
        else if (id === "rename" && selectedView) editName(selectedView);
        else if (id === "update" && selectedView)
          void persist((current) =>
            current.map((item) => (item.id === selectedView.id ? { ...item, ...scope } : item)),
          );
        else if (id === "delete" && selectedView)
          void persist((current) => current.filter((item) => item.id !== selectedView.id)).then(
            (saved) => {
              if (saved) setSelectedId(null);
            },
          );
      }}
    />
  );
}
