import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { Kbd } from "../components/ui/kbd";
import { useScrollingWorkspacesEnabled } from "../hooks/useSettings";
import { trackBrowserSurfaceSlot } from "../browser/browserSurfaceTracking";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import { useThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { countedLayoutWorkspaces } from "./layoutCommands";
import {
  selectFocusedTab,
  selectFocusedWorkspace,
  selectLayoutWorkspaceLeadTab,
  type LayoutTab,
  type LayoutWorkspace,
} from "./layoutModel";
import { useLayoutTabLabel } from "./PaneTabs";
import { useLayoutStore, type LayoutHint as LayoutHintState } from "./layoutStore";

const NO_LEAD_TAB: LayoutTab = {
  id: "none",
  content: { kind: "launcher", id: "none", context: null },
};
const WORKSPACE_BARS = 5;

const ARROWS: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓" };

/** How long a hint stays before its one-shot fade. */
const HINT_VISIBLE_MS = 2400;
const HINT_FADE_MS = 200;
/** Room between the hint and the composer under it. */
const HINT_GAP_PX = 12;
const HINT_BOTTOM_PX = 108;

const FOCUSED_PANE = "[data-layout-pane-focused='true'][data-layout-pane-id]";

/** Fades the hint after a beat, then clears it. */
function useHintLifetime(id: number | null): boolean {
  const [leavingId, setLeavingId] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own and cancel the visible hint dismissal timers.
  useEffect(() => {
    if (id === null) return;
    const fade = window.setTimeout(() => setLeavingId(id), HINT_VISIBLE_MS);
    const clear = window.setTimeout(
      () => useLayoutStore.getState().clearHint(id),
      HINT_VISIBLE_MS + HINT_FADE_MS,
    );
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [id]);
  return id !== null && leavingId === id;
}

/**
 * Draws the terminal hint inside the focused pane, which slides in on top, so the
 * pane's own transform carries it with no per-frame measuring. Column and
 * workspace hints stay in the host: their pane can pass behind the panes it crosses.
 */
function InFocusedPane({ children }: { children: ReactNode }) {
  const [pane, setPane] = useState<{ element: HTMLElement | null } | null>(null);
  const focusedTabId = useLayoutStore((state) => selectFocusedTab(state.layout)?.id ?? null);
  const findPane = (anchor: HTMLSpanElement | null) => {
    if (!anchor) return;
    const element = anchor.parentElement?.querySelector<HTMLElement>(FOCUSED_PANE) ?? null;
    setPane((current) => (current?.element === element ? current : { element }));
  };
  return (
    <>
      {/* Keyed by the focused tab: it remounts, and looks again, when focus moves. */}
      <span hidden key={focusedTabId} ref={findPane} />
      {pane === null ? null : pane.element ? createPortal(children, pane.element) : children}
    </>
  );
}

/**
 * Lifts a hint drawn in its pane a gap above the pane's composer stack when that
 * grows taller than the resting height.
 */
function liftAboveComposer(hint: HTMLDivElement | null) {
  const pane = hint?.parentElement;
  if (!hint || !pane?.hasAttribute("data-layout-pane-id")) return;
  const composer = pane.querySelector('[data-chat-composer-stack="true"]');
  if (!composer) return;
  const lift = () => {
    const paneRect = pane.getBoundingClientRect();
    // Pane pixels: the overview scales panes.
    const scale = pane.offsetHeight > 0 ? paneRect.height / pane.offsetHeight : 1;
    const bottom = (paneRect.bottom - composer.getBoundingClientRect().top) / scale + HINT_GAP_PX;
    hint.style.bottom = bottom > HINT_BOTTOM_PX ? `${bottom}px` : "";
  };
  // Placed before its first paint; the observer only follows later resizes.
  lift();
  return observeResize([pane, composer], lift);
}

/**
 * Puts a hint inside the focused pane, so it rides the pane's own motion,
 * centered at the same height on every pane and lifted a gap above its
 * composer stack (banners, request cards and tray included) when that grows taller.
 */
function useHintPlacement() {
  const focusedTabId = useLayoutStore((state) => selectFocusedTab(state.layout)?.id ?? null);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [placement, setPlacement] = useState<{ pane: HTMLElement | null; bottom: number | null }>({
    pane: null,
    bottom: null,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Find the focused pane in the DOM and observe its composer's size.
  useLayoutEffect(() => {
    const pane = focusedTabId
      ? anchor?.parentElement?.querySelector<HTMLElement>(
          `[data-layout-tab-id="${CSS.escape(focusedTabId)}"][data-layout-pane-id]`,
        )
      : null;
    const composer = pane?.querySelector('[data-chat-composer-stack="true"]');
    const place = () => {
      const lift =
        pane && composer
          ? pane.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + HINT_GAP_PX
          : 0;
      const bottom = lift > HINT_BOTTOM_PX ? lift : null;
      setPlacement((current) =>
        current.pane === (pane ?? null) && current.bottom === bottom
          ? current
          : { pane: pane ?? null, bottom },
      );
    };
    place();
    if (!pane) return;
    return observeResize([pane, ...(composer ? [composer] : [])], place);
  }, [anchor, focusedTabId]);
  return {
    anchorRef: setAnchor,
    pane: placement.pane,
    style: placement.bottom === null ? undefined : { bottom: placement.bottom },
  };
}

function placeHint(placement: ReturnType<typeof useHintPlacement>, pill: ReactElement) {
  return (
    <>
      <span ref={placement.anchorRef} hidden />
      {placement.pane ? createPortal(pill, placement.pane) : pill}
    </>
  );
}

/**
 * The landing hint after a keyboard move, "Column 4 of 4" (pen Q5TwsK), above
 * the focused pane's composer. It appears at once and fades once.
 */
export function LayoutStripHint() {
  const hint = useLayoutStore((state) => state.hint);
  const scrollingWorkspaces = useScrollingWorkspacesEnabled();
  // Owned here: the terminal pill remounts when focus moves it to another pane.
  const terminalLeaving = useHintLifetime(hint?.kind === "terminal" ? hint.id : null);

  // Any workspace switch (keys, sidebar, overview, wheel) names the workspace
  // it landed on for a second (pen qnrAZ), unless a move hint already says so.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to imperative workspace changes that should display a navigation hint.
  useEffect(() => {
    if (!scrollingWorkspaces) return;
    let overviewOpenedOn: string | null = null;
    return useLayoutStore.subscribe((state, previous) => {
      if (state.overviewOpen) {
        if (!previous.overviewOpen) overviewOpenedOn = previous.layout.focusedWorkspaceId;
        return;
      }
      const left = previous.overviewOpen ? overviewOpenedOn : previous.layout.focusedWorkspaceId;
      if (state.layout.focusedWorkspaceId === left) return;
      if (state.hint?.kind === "workspace" && state.hint.id !== previous.hint?.id) return;
      const workspaces = countedLayoutWorkspaces(state.layout);
      const workspace = selectFocusedWorkspace(state.layout);
      // One workspace has nothing to tell apart.
      if (workspaces.length < 2) {
        if (state.hint?.kind === "workspace-name") state.clearHint(state.hint.id);
        return;
      }
      state.showHint({
        kind: "workspace-name",
        workspaceId: workspace.id,
        index: workspaces.indexOf(workspace),
        count: workspaces.length,
      });
    });
  }, [scrollingWorkspaces]);

  if (!hint) return null;
  if (hint.kind === "terminal") {
    return (
      <InFocusedPane>
        <TerminalHintPill key={hint.id} hint={hint} leaving={terminalLeaving} />
      </InFocusedPane>
    );
  }
  // Column and workspace hints coach the scrolling strip.
  if (!scrollingWorkspaces) return null;
  if (hint.kind === "column") return <ColumnHintPill key={hint.id} hint={hint} />;
  return <WorkspaceHintPill key={hint.id} hint={hint} />;
}

function TerminalHintPill({
  hint,
  leaving,
}: {
  hint: Extract<LayoutHintState, { kind: "terminal" }>;
  leaving: boolean;
}) {
  const thread = useThreadShell(hint.threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "terminal.toggle");
  return (
    <div
      ref={liftAboveComposer}
      role="status"
      aria-live="polite"
      data-layout-hint="terminal"
      className={cn(
        "pointer-events-none absolute bottom-27 left-1/2 z-40 flex h-8.5 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg px-3 surface-tooltip transition-opacity duration-200 motion-reduce:transition-none",
        leaving && "opacity-0",
      )}
    >
      <span className="min-w-0 truncate text-meta text-foreground">
        Terminal for {thread?.title ?? "New thread"}
      </span>
      {shortcut ? (
        <span className="kbd-in-popover flex shrink-0">
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </div>
  );
}

/**
 * A workspace's name: the one the user gave it, else the title its focused
 * tab shows in the tab strip.
 */
function useLayoutWorkspaceName(workspace: LayoutWorkspace | null): string {
  const lead = workspace ? selectLayoutWorkspaceLeadTab(workspace) : null;
  const label = useLayoutTabLabel(lead ?? NO_LEAD_TAB);
  if (!workspace) return "Workspace";
  if (workspace.name) return workspace.name;
  if (!lead) return "Empty workspace";
  return label.title;
}

/**
 * "Research · workspace 2 of 3" after sending a pane (pen NFUgn), or just the
 * name after switching (qnrAZ), with a stack of the workspaces.
 */
function WorkspaceHintPill({
  hint,
}: {
  hint: Extract<LayoutHintState, { kind: "workspace" | "workspace-name" }>;
}) {
  const leaving = useHintLifetime(hint.id);
  const workspace = useLayoutStore(
    (state) =>
      state.layout.workspaces.find((candidate) => candidate.id === hint.workspaceId) ?? null,
  );
  const name = useLayoutWorkspaceName(workspace);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keys =
    hint.kind === "workspace" && hint.command
      ? shortcutLabelForCommand(keybindings, hint.command)
      : null;
  const small = hint.kind === "workspace-name";
  const firstBar = Math.max(0, Math.min(hint.index - 2, hint.count - WORKSPACE_BARS));
  const placement = useHintPlacement();
  return placeHint(
    placement,
    <div
      style={placement.style}
      role="status"
      aria-live="polite"
      data-layout-hint={hint.kind}
      className={cn(
        "pointer-events-none absolute bottom-27 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg px-3 surface-tooltip transition-opacity duration-200 motion-reduce:transition-none",
        small ? "h-7.5" : "h-8.5 gap-2.5",
        leaving && "opacity-0",
      )}
    >
      <span aria-hidden className="flex shrink-0 flex-col items-center gap-px">
        {Array.from({ length: Math.min(hint.count, WORKSPACE_BARS) }, (_, bar) => {
          const index = firstBar + bar;
          const more =
            (bar === 0 && index > 0) || (bar === WORKSPACE_BARS - 1 && index < hint.count - 1);
          return (
            <span
              key={bar}
              className={cn(
                "h-1 rounded-xs",
                small ? (more ? "w-1" : "w-2") : more ? "w-1.5" : "w-2.5",
                index === hint.index ? "bg-foreground" : "bg-foreground/20",
              )}
            />
          );
        })}
      </span>
      <span className="min-w-0 truncate text-meta text-foreground">{name}</span>

      {keys ? (
        <span className="kbd-in-popover flex shrink-0">
          <Kbd>{keys}</Kbd>
        </span>
      ) : null}
    </div>,
  );
}

function ColumnHintPill({ hint }: { hint: Extract<LayoutHintState, { kind: "column" }> }) {
  const leaving = useHintLifetime(hint.id);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = hint.command ? shortcutLabelForCommand(keybindings, hint.command) : null;
  const keys = label?.replace(/(Left|Right|Up|Down)$/, (name) => ARROWS[name] ?? name) ?? null;
  const placement = useHintPlacement();
  return placeHint(
    placement,
    <div
      style={placement.style}
      role="status"
      aria-live="polite"
      data-layout-hint="column"
      className={cn(
        "pointer-events-none absolute bottom-27 left-1/2 z-40 flex h-8.5 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg px-3 surface-tooltip transition-opacity duration-200 motion-reduce:transition-none",
        leaving && "opacity-0",
      )}
    >
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        {Array.from({ length: Math.min(hint.count, 8) }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-2.5 rounded-xs",
              index === Math.min(hint.index, 7) ? "w-2.5 bg-foreground" : "w-2 bg-foreground/20",
            )}
          />
        ))}
      </span>
      <span className="min-w-0 truncate text-meta text-foreground">
        Column {hint.index + 1} of {hint.count}
      </span>
      {keys ? (
        <span className="kbd-in-popover flex shrink-0">
          <Kbd>{keys}</Kbd>
        </span>
      ) : null}
    </div>,
  );
}
