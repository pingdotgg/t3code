import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadSearchRecency } from "@t3tools/client-runtime/state/thread-search";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentMachineKind, ScopedThreadRef } from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { threadRecentUse } from "@t3tools/shared/paletteSearch";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useVisibleThreadShells } from "../../state/entities";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentThreadShells } from "../../state/threads";
import {
  buildThreadRouteParams,
  isThreadRoutePathname,
  resolveThreadRouteRef,
} from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { useProjectLookups } from "../CommandPaletteLookups";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  hasUnseenCompletion,
  isSidebarHiddenThread,
  isSidebarThreadWoke,
  resolveSidebarRowStatus,
  resolveSidebarTopStatus,
  resolveThreadLastVisitedAt,
  threadShortcutContext,
} from "../Sidebar.logic";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import {
  RelativeTimeLabel,
  SidebarProviderStack,
  SidebarRemoteMachineIcon,
} from "../sidebar/SidebarThreadRow";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
  type SidebarProviderEntry,
} from "../sidebar/sidebarProviderEntries";
import { ThreadTopStatusLabel } from "../sidebar/ThreadTopStatus";
import { CommandFooter, CommandListHeading, CommandOverlayPopup } from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { MiddleTruncate } from "../ui/middle-truncate";
import {
  openSwitcher,
  switcherKeyEvent,
  tapTarget,
  updateSwitcher,
  type SwitcherEvent,
  type SwitcherOpen,
  type SwitcherResult,
  type SwitcherState,
} from "./recentThreadSwitcher.logic";
import { recentThreadList } from "./recentThreadVisits.logic";
import {
  readThreadVisits,
  recordThreadVisit,
  setRecentThreadSwitcherOpen,
} from "./recentThreadVisitsStore";

const SHOW_DELAY_MS = 200;

interface SwitcherView {
  readonly open: SwitcherOpen;
  // Read once, when the switcher opens.
  readonly now: string;
}

type Dispatch = (event: SwitcherEvent) => void;

const threadKeyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const listedThreads = () =>
  appAtomRegistry
    .get(environmentThreadShells.visibleThreadShellsAtom)
    .filter((thread) => thread.archivedAt === null && !isSidebarHiddenThread(thread));

// Closed popups can stay mounted, so only open ones count.
const MODAL_SELECTOR = ["dialog-popup", "alert-dialog-popup", "sheet-popup"]
  .map((slot) => `[data-slot="${slot}"][data-open]`)
  .join(",");

// Window listeners added after the dispatcher's, such as the chat's while the terminal is
// focused, act on handled keys too.
function takeEvent(event: KeyboardEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function createRecentThreadSwitcher(
  router: AnyRouter,
  render: (view: SwitcherView | null) => void,
) {
  let state: SwitcherState = null;
  let now = "";
  let opener = { code: "", backwards: false };
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseKeys: (() => void) | null = null;

  const routeThreadRef = () => resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});

  const navigateTo = (threadKey: string) => {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null) return;
    void router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  const apply = (result: SwitcherResult) => {
    state = result.state;
    setRecentThreadSwitcherOpen(state !== null);
    render(state === null ? null : { open: state, now });
    if (state === null) {
      if (showTimer !== null) clearTimeout(showTimer);
      showTimer = null;
      releaseKeys?.();
      releaseKeys = null;
    }
    // A thread archived or deleted while the list was open is not opened.
    const switchTo = result.switchTo;
    if (switchTo !== null && listedThreads().some((thread) => threadKeyOf(thread) === switchTo)) {
      navigateTo(switchTo);
    }
  };

  const dispatch: Dispatch = (event) => {
    if (state !== null) apply(updateSwitcher(state, event));
  };

  const readList = (backwards: boolean) => {
    const fill = listedThreads().map((thread) => ({
      key: threadKeyOf(thread),
      // Not `threadSearchSubject`: its cache holds one subject per shell, the palette's.
      recentUse: threadRecentUse(threadSearchRecency(thread)),
    }));
    const visibleKeys = new Set(fill.map((candidate) => candidate.key));
    const { keys, ownCount } = recentThreadList(readThreadVisits(), visibleKeys, fill);
    // The first row is covered unless the window is on its thread. The latest location already
    // names a switch that has not resolved yet, so a quick second tap sees where the first went.
    const firstRef = keys[0] === undefined ? null : parseScopedThreadKey(keys[0]);
    const covered =
      firstRef === null || !isThreadRoutePathname(router.latestLocation.pathname, firstRef);
    return { keys, options: { backwards, covered, ownCount } };
  };

  const onKeyDown = (event: KeyboardEvent) => {
    takeEvent(event);
    const switcherEvent = switcherKeyEvent(event, opener);
    if (switcherEvent !== null) dispatch(switcherEvent);
    return true;
  };

  const open = (event: KeyboardEvent, backwards: boolean) => {
    if (isCommandPaletteOpen() || document.querySelector(MODAL_SELECTOR) !== null) return false;
    takeEvent(event);
    const list = readList(backwards);
    // Only Ctrl is held for the list; any other binding switches at once.
    if (!event.ctrlKey) {
      const target = tapTarget(list.keys, list.options);
      if (target !== null) navigateTo(target);
      return;
    }
    opener = { code: event.code, backwards };
    now = new Date().toISOString();
    apply(openSwitcher(list.keys, list.options));
    if (state === null) return;
    // Capture scopes run newest first, so this one beats any a component (the composer's stash)
    // registered since mount.
    releaseKeys = registerCommands({}, { capture: true, onKeyDown });
    showTimer = setTimeout(() => dispatch({ type: "show" }), SHOW_DELAY_MS);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Control") dispatch({ type: "commit" });
  };

  const onBlur = () => dispatch({ type: "cancel" });

  // Once shown, the list's own backdrop takes outside presses.
  const onPointerDown = () => {
    if (state !== null && !state.shown) dispatch({ type: "cancel" });
  };

  const recordVisit = (ref: ScopedThreadRef | null) => {
    if (ref !== null) recordThreadVisit(scopedThreadKey(ref));
  };

  const start = () => {
    recordVisit(routeThreadRef());
    const disposers = [
      // A first visit can take a while to resolve; a quick tap must already count it.
      router.subscribe("onBeforeNavigate", ({ toLocation }) =>
        recordVisit(resolveThreadRouteRef(router.matchRoutes(toLocation).at(-1)?.params ?? {})),
      ),
      registerCommands(
        {
          "thread.recent.next": (event) => open(event, false),
          "thread.recent.previous": (event) => open(event, true),
        },
        { capture: true, context: () => threadShortcutContext(routeThreadRef()) },
      ),
    ];
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      for (const dispose of disposers) dispose();
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
      onBlur();
    };
  };

  return { start, dispatch };
}

/** Ctrl+Tab's recent threads: a tap flips back, a hold shows the list. */
export function RecentThreadSwitcher() {
  const router = useRouter();
  const [view, setView] = useState<SwitcherView | null>(null);
  const [liveRegion, setLiveRegion] = useState<HTMLElement | null>(null);
  const [switcher] = useState(() => createRecentThreadSwitcher(router, setView));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the switcher's key scope, window key-up and blur listeners, and the route visit recorder
  useEffect(() => switcher.start(), [switcher]);

  return (
    <>
      {/* Focus stays where it was, so the highlighted row is read out here. Mounted while closed:
          screen readers often skip a live region that arrives already holding text. */}
      <div ref={setLiveRegion} aria-live="polite" aria-atomic="true" className="sr-only" />
      {view?.open.shown ? (
        <RecentThreadList view={view} liveRegion={liveRegion} dispatch={switcher.dispatch} />
      ) : null}
    </>
  );
}

const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

function RecentThreadList(props: {
  readonly view: SwitcherView;
  readonly liveRegion: HTMLElement | null;
  readonly dispatch: Dispatch;
}) {
  const { open, now } = props.view;
  const headingId = useId();
  const threads = useVisibleThreadShells();
  const { projectByKey } = useProjectLookups();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentMachineById = useEnvironmentMachines();
  const threadByKey = new Map(threads.map((thread) => [threadKeyOf(thread), thread]));

  return (
    <div
      className="fixed inset-0 z-[130] [-webkit-app-region:no-drag]"
      onPointerDown={(event) => {
        event.preventDefault();
        props.dispatch({ type: "cancel" });
      }}
    >
      {/* Pressing on the list keeps focus where it was. */}
      <CommandOverlayPopup
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="flex min-h-0 flex-col p-2">
          <CommandListHeading id={headingId}>Recent threads</CommandListHeading>
          <div
            role="listbox"
            aria-labelledby={headingId}
            className="min-h-0 overflow-y-auto overscroll-contain"
          >
            {open.order.map((key, index) => {
              const thread = threadByKey.get(key);
              if (thread === undefined) return null;
              return (
                <RecentThreadRow
                  key={key}
                  thread={thread}
                  project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
                  now={now}
                  current={index === 0 && !open.covered}
                  index={index}
                  count={open.order.length}
                  selected={index === open.highlight}
                  remoteMachine={
                    thread.environmentId === primaryEnvironmentId
                      ? null
                      : (environmentMachineById.get(thread.environmentId) ?? "server")
                  }
                  providerEntryByInstanceId={
                    providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
                  }
                  liveRegion={props.liveRegion}
                  dispatch={props.dispatch}
                />
              );
            })}
          </div>
        </div>
        <CommandFooter>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <KbdGroup>
              <Kbd>{isMacPlatform(navigator.platform) ? "⌃" : "Ctrl"}</Kbd>
              <span>Release to open</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span>Cancel</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </CommandOverlayPopup>
    </div>
  );
}

function RecentThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject | null;
  readonly now: string;
  readonly current: boolean;
  readonly index: number;
  readonly count: number;
  readonly selected: boolean;
  readonly remoteMachine: EnvironmentMachineKind | null;
  readonly providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  readonly liveRegion: HTMLElement | null;
  readonly dispatch: Dispatch;
}) {
  const { thread, project, index, selected, dispatch } = props;
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[threadKeyOf(thread)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const status = resolveSidebarRowStatus({ ...thread, lastVisitedAt });
  const topStatus = resolveSidebarTopStatus({
    status,
    goalActive: thread.goal?.status === "active",
    isWoke: isSidebarThreadWoke({
      wokeAt: threadWokeAt(thread, { now: props.now }),
      lastVisitedAt,
      settledOverride: thread.settledOverride,
    }),
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
  const spoken = [
    thread.title,
    project?.title,
    thread.branch,
    topStatus?.label,
    props.current ? "current" : null,
    `${index + 1} of ${props.count}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      ref={selected ? scrollIntoView : undefined}
      role="option"
      aria-selected={selected}
      aria-label={spoken}
      className="flex cursor-default select-none items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
      onClick={() => dispatch({ type: "choose", index })}
      // On macOS a primary click with Ctrl held, as the list is, is a context menu.
      onContextMenu={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dispatch({ type: "choose", index });
      }}
    >
      {project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null}
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-5 min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span>
          <span className="flex shrink-0 items-center text-muted-foreground text-xs tabular-nums">
            {topStatus ? (
              <ThreadTopStatusLabel topStatus={topStatus} status={status} thread={thread} />
            ) : props.current ? (
              "Current"
            ) : (
              <RelativeTimeLabel timestamp={resolveThreadActivityTimestamp(thread)} />
            )}
          </span>
        </span>
        <span className="flex h-4 min-w-0 items-center gap-1.5 text-secondary-label text-xs">
          {project ? <span className="max-w-[40%] shrink-0 truncate">{project.title}</span> : null}
          {thread.branch ? (
            <>
              {project ? <span className="shrink-0 text-muted-foreground/70">·</span> : null}
              <ThreadWorktreeIndicator thread={thread} tooltip={false} />
              <span className="flex min-w-0 flex-1">
                <MiddleTruncate value={thread.branch} showTitle={false} />
              </span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          <span className="inline-flex shrink-0 items-center gap-1">
            {props.remoteMachine ? <SidebarRemoteMachineIcon kind={props.remoteMachine} /> : null}
            <SidebarProviderStack
              thread={thread}
              providerEntryByInstanceId={props.providerEntryByInstanceId}
            />
          </span>
        </span>
      </span>
      {selected && props.liveRegion ? createPortal(spoken, props.liveRegion) : null}
    </div>
  );
}
