import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClosedViewStore } from "../closedViewStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { effectiveShortcutsForCommand, resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  planNextReopen,
  pullRequestsSearchForRestore,
  reopenClosedView,
} from "../reopenClosedView";
import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { toastManager } from "./ui/toast";

const isGlobalPullRequests = (ref: ScopedThreadRef) =>
  scopedThreadKey(ref) === scopedThreadKey(PULL_REQUESTS_PANEL_REF);

export function ReopenClosedViewShortcut() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const target = resolveThreadRouteTarget(params);
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const threadRef =
    target?.kind === "server"
      ? target.threadRef
      : draft
        ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId))
        : null;
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
  const previewOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "preview",
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasHistory = useClosedViewStore((state) => state.entries.length > 0);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const pending = useRef(Promise.resolve());

  const reopenNext = useEffectEvent(async () => {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const drafts = useComposerDraftStore.getState();
    const panelsByThread = useRightPanelStore.getState().byThreadKey;
    const { drop, restore } = planNextReopen(useClosedViewStore.getState().entries, (entry) => {
      const ref = entry.threadRef;
      const panel = selectThreadRightPanelState(panelsByThread, ref);
      if (isGlobalPullRequests(ref)) {
        return {
          environmentKnown: true,
          catalogReady: true,
          ownerExists: true,
          shellLive: true,
          panel,
        };
      }
      return {
        environmentKnown: catalog.entries.has(ref.environmentId),
        catalogReady: catalog.isReady,
        ownerExists: readThreadShell(ref) !== null || drafts.getDraftThreadByRef(ref) !== null,
        shellLive:
          appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
        panel,
      };
    });
    for (const entry of drop) useClosedViewStore.getState().remove(entry.id);
    if (!restore) return;

    const ref = restore.threadRef;
    const globalPullRequests = isGlobalPullRequests(ref);
    const thread = globalPullRequests ? null : readThreadShell(ref);
    const owner = thread ?? drafts.getDraftThreadByRef(ref);
    const project = owner ? readProject(scopeProjectRef(ref.environmentId, owner.projectId)) : null;
    if (!(await reopenClosedView(restore, { openPreview, workspaceAvailable: project !== null })))
      return;
    if (globalPullRequests) {
      const selected = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ref,
      );
      await navigate({
        to: "/pull-requests",
        search: (previous) => pullRequestsSearchForRestore(previous, selected),
      });
    } else {
      const draftId = thread === null ? drafts.getDraftIdByRef(ref) : null;
      if (draftId !== null)
        await navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) });
      else await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    }
    useClosedViewStore.getState().remove(restore.id);
  });

  const enqueueReopen = useEffectEvent(() => {
    pending.current = pending.current
      .then(() => reopenNext())
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reopen view",
          description: error instanceof Error ? error.message : String(error),
        });
      });
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isCommandPaletteOpen() ||
        useClosedViewStore.getState().entries.length === 0 ||
        (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "view.reopenClosed") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) enqueueReopen();
    };
    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "view.reopenClosed" && !isCommandPaletteOpen()) enqueueReopen();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, previewOpen, terminalOpen]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.setForwardedShortcuts) return;
    void preview
      .setForwardedShortcuts(
        hasHistory
          ? effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
              context: {
                previewFocus: true,
                previewOpen: true,
                terminalFocus: false,
                terminalOpen,
                editableFocus: false,
                modelPickerOpen: false,
                isDesktop: true,
                isWeb: false,
              },
            }).map((shortcut) => ({ command: "view.reopenClosed", shortcut }))
          : [],
      )
      .catch(() => undefined);
    return () => {
      void preview.setForwardedShortcuts?.([]).catch(() => undefined);
    };
  }, [hasHistory, keybindings, terminalOpen]);

  return null;
}
