import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";

import { Kbd } from "../components/ui/kbd";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import { useThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { countedLayoutWorkspaces } from "./layoutCommands";
import {
  selectFocusedWorkspace,
  selectLayoutWorkspaceLeadTab,
  type LayoutWorkspace,
} from "./layoutModel";
import { useLayoutStore, type LayoutHint as LayoutHintState } from "./layoutStore";

const ARROWS: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓" };

/** How long a hint stays before its one-shot fade. */
const HINT_VISIBLE_MS = 2400;
const HINT_FADE_MS = 200;
/** Room between the hint and the composer (or the pane's bottom) under it. */
const HINT_GAP_PX = 12;
const HINT_EDGE_PX = 16;

/** Fades the hint after a beat, then clears it. */
function useHintLifetime(id: number): boolean {
  const [leaving, setLeaving] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own and cancel the visible hint dismissal timers.
  useEffect(() => {
    const fade = window.setTimeout(() => setLeaving(true), HINT_VISIBLE_MS);
    const clear = window.setTimeout(
      () => useLayoutStore.getState().clearHint(id),
      HINT_VISIBLE_MS + HINT_FADE_MS,
    );
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [id]);
  return leaving;
}

/**
 * Centers a hint on the focused pane, a gap above its composer stack (banners,
 * request cards and tray included), or above the pane's bottom when it has no
 * composer. Follows the strip while it scrolls to the landed pane.
 */
function useHintPlacement() {
  const [hint, setHint] = useState<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the focused pane and observe viewport changes to position the hint.
  useLayoutEffect(() => {
    const host = hint?.offsetParent;
    if (!host) return;
    const place = () => {
      const pane = host.querySelector("[data-layout-pane-focused='true'][data-layout-pane-id]");
      if (!pane) return;
      const hostRect = host.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const composer = pane.querySelector('[data-chat-composer-stack="true"]');
      const floor = composer
        ? composer.getBoundingClientRect().top - HINT_GAP_PX
        : paneRect.bottom - HINT_EDGE_PX;
      setStyle({
        left: paneRect.left + paneRect.width / 2 - hostRect.left,
        bottom: hostRect.bottom - floor,
        maxWidth: paneRect.width - 2 * HINT_EDGE_PX,
      });
    };
    place();
    const pane = host.querySelector("[data-layout-pane-focused='true'][data-layout-pane-id]");
    const composer = pane?.querySelector('[data-chat-composer-stack="true"]');
    const stopResize = observeResize(
      [host, ...(pane ? [pane] : []), ...(composer ? [composer] : [])],
      place,
    );
    // A pane that just landed can mount its composer a frame later.
    const frame = window.requestAnimationFrame(place);
    host.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      stopResize();
      host.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [hint]);
  return [setHint, style] as const;
}

/**
 * The landing hint after a keyboard move, "Column 4 of 4" (pen Q5TwsK), above
 * the focused pane's composer. It appears at once and fades once.
 */
export function LayoutStripHint() {
  const hint = useLayoutStore((state) => state.hint);

  // Any workspace switch (keys, sidebar, overview, wheel) names the workspace
  // it landed on for a second (pen qnrAZ), unless a move hint already says so.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to imperative workspace changes that should display a navigation hint.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, previous) => {
        if (state.layout.focusedWorkspaceId === previous.layout.focusedWorkspaceId) return;
        if (state.overviewOpen) return;
        if (state.hint?.kind === "workspace" && state.hint.id !== previous.hint?.id) return;
        const workspaces = countedLayoutWorkspaces(state.layout);
        const workspace = selectFocusedWorkspace(state.layout);
        // One workspace has nothing to tell apart.
        if (workspaces.length < 2) return;
        state.showHint({
          kind: "workspace-name",
          workspaceId: workspace.id,
          index: workspaces.indexOf(workspace),
          count: workspaces.length,
        });
      }),
    [],
  );

  if (!hint) return null;
  if (hint.kind === "terminal") return <TerminalHintPill key={hint.id} hint={hint} />;
  if (hint.kind === "column") return <ColumnHintPill key={hint.id} hint={hint} />;
  return <WorkspaceHintPill key={hint.id} hint={hint} />;
}

function TerminalHintPill({ hint }: { hint: Extract<LayoutHintState, { kind: "terminal" }> }) {
  const leaving = useHintLifetime(hint.id);
  const thread = useThreadShell(hint.threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const [placementRef, placement] = useHintPlacement();
  return (
    <div
      ref={placementRef}
      style={placement}
      role="status"
      aria-live="polite"
      data-layout-hint="terminal"
      className={cn(
        "pointer-events-none absolute bottom-30 left-1/2 z-40 flex h-8.5 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg px-3 surface-tooltip transition-opacity duration-200 motion-reduce:transition-none",
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
 * A workspace's name: the one the user gave it, else its first thread's
 * title, else what it is.
 */
function useLayoutWorkspaceName(workspace: LayoutWorkspace | null): string {
  const lead = workspace ? selectLayoutWorkspaceLeadTab(workspace) : null;
  const target = lead?.content.kind === "chat" ? lead.content.target : null;
  const thread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  if (!workspace) return "Workspace";
  if (workspace.name) return workspace.name;
  if (workspace.columns.length === 0) return "Empty workspace";
  if (target?.kind === "draft") return "New thread";
  return thread?.title ?? "Workspace";
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
  const [placementRef, placement] = useHintPlacement();
  return (
    <div
      ref={placementRef}
      style={placement}
      role="status"
      aria-live="polite"
      data-layout-hint={hint.kind}
      className={cn(
        "pointer-events-none absolute bottom-30 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg px-3 surface-tooltip transition-opacity duration-200 motion-reduce:transition-none",
        small ? "h-7.5" : "h-8.5 gap-2.5",
        leaving && "opacity-0",
      )}
    >
      <span aria-hidden className="flex shrink-0 flex-col gap-0.5">
        {Array.from({ length: Math.min(hint.count, 5) }, (_, index) => (
          <span
            key={index}
            className={cn(
              "rounded-xs",
              small ? "h-1.25 w-2" : "h-1.5 w-2.5",
              index === Math.min(hint.index, 4) ? "bg-foreground" : "bg-foreground/20",
            )}
          />
        ))}
      </span>
      <span className="min-w-0 truncate text-meta text-foreground">
        {small ? name : `${name} · workspace ${hint.index + 1} of ${hint.count}`}
      </span>
      {keys ? (
        <span className="kbd-in-popover flex shrink-0">
          <Kbd>{keys}</Kbd>
        </span>
      ) : null}
    </div>
  );
}

function ColumnHintPill({ hint }: { hint: Extract<LayoutHintState, { kind: "column" }> }) {
  const leaving = useHintLifetime(hint.id);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = hint.command ? shortcutLabelForCommand(keybindings, hint.command) : null;
  const keys = label?.replace(/(Left|Right|Up|Down)$/, (name) => ARROWS[name] ?? name) ?? null;
  const [placementRef, placement] = useHintPlacement();
  return (
    <div
      ref={placementRef}
      style={placement}
      role="status"
      aria-live="polite"
      data-layout-hint="column"
      className={cn(
        "pointer-events-none absolute bottom-30 left-1/2 z-40 flex h-8.5 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg px-3 surface-tooltip transition-opacity duration-200 motion-reduce:transition-none",
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
    </div>
  );
}
