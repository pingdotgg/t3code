import { m } from "../i18n/messages";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { linkOptions, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
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
  ISSUES_PANEL_REF,
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { serverEnvironment } from "../state/server";
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
import { readIssueListPreferences } from "./issue/issueListPreferences";

declare module "@tanstack/react-router" {
  interface HistoryState {
    reopenedViewId?: string;
  }
}

const PREVIEW_FORWARDED_COMMANDS = [
  "workspace.focusNext",
  "workspace.focusPrevious",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "rightPanel.new",
  "rightPanel.close",
  "rightPanel.nextSurface",
  "rightPanel.previousSurface",
  "preview.focusUrl",
  "preview.zoomIn",
  "preview.zoomOut",
  "preview.resetZoom",
  "preview.find",
] as const;

const isGlobalPullRequests = (ref: ScopedThreadRef) =>
  scopedThreadKey(ref) === scopedThreadKey(PULL_REQUESTS_PANEL_REF);
const isGlobalIssues = (ref: ScopedThreadRef) =>
  scopedThreadKey(ref) === scopedThreadKey(ISSUES_PANEL_REF);

export function ReopenClosedViewShortcut() {
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
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
  type ReopenNavigation = { location: typeof router.history.location };
  const reopenNavigation = useRef<ReopenNavigation | null>(null);

  const reopenNext = useEffectEvent(async (request: ReopenNavigation) => {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const drafts = useComposerDraftStore.getState();
    const panelsByThread = useRightPanelStore.getState().byThreadKey;
    const { drop, restore } = planNextReopen(useClosedViewStore.getState().entries, (entry) => {
      const ref = entry.threadRef;
      const panel = selectThreadRightPanelState(panelsByThread, ref);
      if (isGlobalPullRequests(ref) || isGlobalIssues(ref)) {
        return {
          environmentKnown: true,
          catalogReady: true,
          ownerExists: true,
          sideChatExists: true,
          shellLive: true,
          panel,
        };
      }
      return {
        environmentKnown: catalog.entries.has(ref.environmentId),
        catalogReady: catalog.isReady,
        ownerExists: readThreadShell(ref) !== null || drafts.getDraftThreadByRef(ref) !== null,
        sideChatExists:
          entry.kind !== "panel-tab" ||
          entry.surface.kind !== "thread" ||
          readThreadShell(scopeThreadRef(ref.environmentId, entry.surface.threadId)) !== null ||
          // The shell leaves idle subagents out, so one it does not list may still exist.
          appAtomRegistry.get(serverEnvironment.configValueAtom(ref.environmentId))
            ?.shellThreadFamilies === true,
        shellLive:
          appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
        panel,
      };
    });
    for (const entry of drop) useClosedViewStore.getState().remove(entry.id);
    if (!restore) return;

    const ref = restore.threadRef;
    const globalPullRequests = isGlobalPullRequests(ref);
    const globalIssues = isGlobalIssues(ref);
    const thread = globalPullRequests || globalIssues ? null : readThreadShell(ref);
    const owner = thread ?? drafts.getDraftThreadByRef(ref);
    const project = owner ? readProject(scopeProjectRef(ref.environmentId, owner.projectId)) : null;
    if (!(await reopenClosedView(restore, { openPreview, workspaceAvailable: project !== null }))) {
      useClosedViewStore.getState().defer(restore.id);
      return;
    }
    useClosedViewStore.getState().remove(restore.id);
    if (router.history.location !== request.location) return;

    let destination;
    if (globalPullRequests) {
      const selected = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ref,
      );
      destination = linkOptions({
        to: "/pull-requests",
        search: (previous) => pullRequestsSearchForRestore(previous, selected),
      });
    } else if (globalIssues) {
      destination = linkOptions({ to: "/issues", search: readIssueListPreferences() });
    } else {
      const draftId = thread === null ? drafts.getDraftIdByRef(ref) : null;
      destination =
        draftId !== null
          ? linkOptions({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) })
          : linkOptions({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    }

    const { history } = router;
    if (router.buildLocation(destination).publicHref === history.location.href) {
      const { reopenedViewId } = history.location.state;
      await navigate({ ...destination, state: reopenedViewId ? { reopenedViewId } : {} });
      return;
    }

    // An allowing blocker can defer the commit. Only the reopen's first history hop extends the queue.
    const unsubscribe = history.subscribe(({ location, action }) => {
      if (location === request.location) return;
      unsubscribe();
      if (action.type === "PUSH" && location.state.reopenedViewId === restore.id) {
        request.location = location;
      }
    });
    try {
      await navigate({ ...destination, state: { reopenedViewId: restore.id } });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    unsubscribe();
  });

  const enqueueReopen = useEffectEvent(() => {
    const location = router.history.location;
    const previous = reopenNavigation.current;
    const request = previous?.location === location ? previous : { location };
    reopenNavigation.current = request;
    pending.current = pending.current
      .then(() => reopenNext(request))
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: gt("Could not reopen view"),
          description: thrownErrorMessage(error, m) ?? String(error),
        });
      });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown and the desktop menu action for the reopen closed view shortcut
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers forwarded shortcut chords with the desktop preview bridge and clears them on cleanup
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const options = {
      context: {
        previewFocus: true,
        previewOpen: true,
        rightPanelOpen: true,
        terminalFocus: false,
        terminalOpen,
        editableFocus: false,
        modelPickerOpen: false,
        isDesktop: true,
        isWeb: false,
      },
    };
    // Guest browser processes miss app keydown listeners; desktop forwards the chords as menu actions.
    const commands = [
      ...(hasHistory ? (["view.reopenClosed"] as const) : []),
      ...PREVIEW_FORWARDED_COMMANDS,
    ];
    void preview
      .setForwardedShortcuts(
        commands.flatMap((command) =>
          effectiveShortcutsForCommand(keybindings, command, options).map((shortcut) => ({
            command,
            shortcut,
          })),
        ),
      )
      .catch(() => undefined);
    return () => {
      void preview.setForwardedShortcuts([]).catch(() => undefined);
    };
  }, [hasHistory, keybindings, terminalOpen]);

  return null;
}
