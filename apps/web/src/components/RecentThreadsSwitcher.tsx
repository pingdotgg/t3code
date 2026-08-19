/**
 * Alt-tab style switcher over the threads opened this session, newest first.
 * Ctrl+Tab opens it and advances, Ctrl+Shift+Tab goes back, releasing the
 * held modifier opens the highlighted thread, Escape cancels. Mounted once at
 * the root so it works on every route, with or without the sidebar.
 *
 * Browsers reserve Ctrl+Tab for their own tab switching, so the default
 * shortcut only ever reaches us in the desktop app; in a browser the commands
 * stay inert until the user rebinds them to reachable keys.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { recentThreadsDirectionFromCommand, resolveShortcutCommand } from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  type RecentThreadsSwitcherSession,
  reconcileRecentThreadsSwitcherSession,
  shouldCommitRecentThreadsSwitcherOnKeyUp,
} from "../recentThreadsSwitcherLogic";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { useRecentThreadsStore } from "../recentThreadsStore";
import { readProject, readThreadShell, readThreadStatus } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";

function isLiveRecentThreadKey(key: string): boolean {
  const ref = parseScopedThreadKey(key);
  if (!ref) return false;
  const shell = readThreadShell(ref);
  return shell !== null && shell.archivedAt === null && readThreadStatus(ref) !== "deleted";
}

/** Recent thread keys that still resolve to a live, unarchived thread. */
function liveRecentThreadKeys(): string[] {
  return useRecentThreadsStore.getState().recentThreadKeys.filter(isLiveRecentThreadKey);
}

export function RecentThreadsSwitcher() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  const [session, setSession] = useState<RecentThreadsSwitcherSession | null>(null);
  // Keydown and keyup are native window listeners with no React flush between
  // them, so the ref is written eagerly on every transition — reading state
  // through the render-synced ref would let a keyup commit a cancelled session.
  const sessionRef = useRef(session);
  const updateSession = (next: RecentThreadsSwitcherSession | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  const cancel = useEffectEvent(() => {
    if (sessionRef.current === null) return;
    updateSession(null);
  });

  const commit = useEffectEvent((requestedKey?: string) => {
    const current = sessionRef.current;
    if (!current) return;
    const reconciled = reconcileRecentThreadsSwitcherSession(current, isLiveRecentThreadKey);
    updateSession(null);
    if (!reconciled) return;
    const key =
      requestedKey !== undefined && reconciled.entries.includes(requestedKey)
        ? requestedKey
        : reconciled.entries[reconciled.selectedIndex];
    if (key === undefined) return;
    const ref = parseScopedThreadKey(key);
    if (!ref || !isLiveRecentThreadKey(key)) return;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  });

  const handleWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const current = sessionRef.current;
    if (current) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commit();
        return;
      }
    }
    if (event.defaultPrevented) return;
    if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")) {
      return;
    }
    const direction = recentThreadsDirectionFromCommand(
      resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      }),
    );
    if (direction === null) return;
    if (!current && isCommandPaletteOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    // Swallow key repeats after claiming the shortcut: one step per physical
    // press keeps held-modifier cycling controllable.
    if (event.repeat) return;
    const step = direction === "next" ? 1 : -1;
    if (current) {
      const reconciled = reconcileRecentThreadsSwitcherSession(current, isLiveRecentThreadKey);
      if (!reconciled) {
        cancel();
        return;
      }
      const count = reconciled.entries.length;
      updateSession({
        ...reconciled,
        selectedIndex: (reconciled.selectedIndex + step + count) % count,
      });
      return;
    }
    const entries = liveRecentThreadKeys();
    const routeThreadKey =
      routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
    if (entries.length === 0 || (entries.length === 1 && entries[0] === routeThreadKey)) return;
    const start =
      entries[0] === routeThreadKey && direction === "next"
        ? 1
        : direction === "next"
          ? 0
          : entries.length - 1;
    updateSession({
      entries,
      selectedIndex: start,
      holdsCtrl: event.ctrlKey,
      holdsMeta: event.metaKey,
      holdsAlt: event.altKey,
      holdsShift: event.shiftKey,
      triggerKey: event.code || event.key,
    });
  });

  const handleWindowKeyUp = useEffectEvent((event: KeyboardEvent) => {
    const current = sessionRef.current;
    if (!current) return;
    if (shouldCommitRecentThreadsSwitcherOnKeyUp(current, event)) commit();
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleWindowKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => handleWindowKeyUp(event);
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="recent-threads-switcher"]')
      ) {
        return;
      }
      cancel();
    };
    const onWindowBlur = () => cancel();
    // Capture phase so held-modifier cycling beats focused editors and the
    // terminal drawer, mirroring the sidebar toggle listener.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  if (!session) return null;
  const reconciled = reconcileRecentThreadsSwitcherSession(session, isLiveRecentThreadKey);
  if (!reconciled) return null;
  return (
    <RecentThreadsSwitcherOverlay
      entries={reconciled.entries}
      selectedIndex={reconciled.selectedIndex}
      onSelect={commit}
    />
  );
}

function RecentThreadsSwitcherOverlay({
  entries,
  selectedIndex,
  onSelect,
}: {
  entries: ReadonlyArray<string>;
  selectedIndex: number;
  onSelect: (threadKey: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="pointer-events-none fixed inset-0 z-100 flex justify-center px-4">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Recent threads"
        data-testid="recent-threads-switcher"
        className="dialog-glass pointer-events-auto mt-[14vh] flex h-fit max-h-[60vh] w-full max-w-md flex-col gap-0.5 overflow-y-auto rounded-2xl border p-1.5"
      >
        {entries.map((threadKey, index) => (
          <RecentThreadsSwitcherRow
            key={threadKey}
            threadKey={threadKey}
            selected={index === selectedIndex}
            onClick={() => onSelect(threadKey)}
          />
        ))}
      </div>
    </div>
  );
}

function RecentThreadsSwitcherRow({
  threadKey,
  selected,
  onClick,
}: {
  threadKey: string;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = parseScopedThreadKey(threadKey);
  const shell = ref ? readThreadShell(ref) : null;
  if (!ref || !shell) return null;
  const projectTitle = readProject(scopeProjectRef(ref.environmentId, shell.projectId))?.title;
  const description = [projectTitle, shell.branch ? `#${shell.branch}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      role="option"
      // Keyboard interaction is owned by the window listener. Keep rows out of
      // the tab order and prevent pointer focus so committing preserves the
      // focus the user had before opening the switcher.
      tabIndex={-1}
      aria-selected={selected}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <span className="w-full truncate text-sm font-medium">{shell.title}</span>
      {description.length > 0 ? (
        <span className="w-full truncate text-xs text-muted-foreground">{description}</span>
      ) : null}
    </button>
  );
}
