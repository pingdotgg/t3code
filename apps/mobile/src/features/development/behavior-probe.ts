// Read by evals/mobile-behavior through the Hermes inspector; product modules load lazily so import order is unchanged.

interface Fiber {
  readonly tag: number;
  readonly type: unknown;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly memoizedProps: Record<string, unknown> | null;
}
interface DevToolsHook {
  onCommitFiberRoot?: (
    id: unknown,
    root: { current: Fiber & { readonly actualDuration?: number } },
    ...rest: unknown[]
  ) => unknown;
  __t3BehaviorProbe?: true;
}
interface ListState {
  readonly scroll: number;
  readonly scrollLength: number;
  readonly contentLength: number;
  readonly isAtEnd: boolean;
  readonly start: number;
  readonly end: number;
  readonly data: ReadonlyArray<{ readonly id?: string; readonly key?: string }>;
  readonly positionAtIndex: (index: number) => number;
}
interface Feed {
  readonly threadId: string;
  readonly environmentId: string;
  readonly list: { readonly current: { getState?: () => ListState } | null } | undefined;
  following: boolean | null;
}
interface Atom {
  readonly _atom: true;
}

// Every root React has committed; LogBox and other overlays commit their own.
const roots = new Set<{ current: Fiber }>();

function installCommitHook() {
  const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || typeof hook.onCommitFiberRoot !== "function") {
    setTimeout(installCommitHook, 50);
    return;
  }
  if (hook.__t3BehaviorProbe) return;
  hook.__t3BehaviorProbe = true;
  const original = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = (id, next, ...rest) => {
    roots.add(next);
    // Development builds time each commit's render work on the root fiber.
    if (perf) perf.commits.push({ at: performance.now(), ms: next.current.actualDuration ?? 0 });
    return original(id, next, ...rest);
  };
}

/** What one measured interaction did, from `perfStart` to `perfStop`; read by mobile:metrics. */
interface PerfWindow {
  readonly startedAt: number;
  readonly inputs: Array<{ readonly kind: string; readonly at: number }>;
  readonly commits: Array<{ readonly at: number; readonly ms: number }>;
  readonly content: Array<{ readonly thread: string; readonly at: number; frameAt: number | null }>;
  readonly keys: number[];
}
let perf: PerfWindow | null = null;
const perfInput = (kind: string) => perf?.inputs.push({ kind, at: performance.now() });

// The app's input points (see perf-probe-hooks.ts); they record only inside a window.
Object.assign(globalThis, {
  __t3PerfProbe: {
    touchStart: () => perfInput("touch-start"),
    touchEnd: () => perfInput("touch-end"),
    menuAction: () => perfInput("menu-action"),
    key: () => {
      const window = perf;
      if (!window) return;
      const at = performance.now();
      window.inputs.push({ kind: "key", at });
      requestAnimationFrame(() => window.keys.push(performance.now() - at));
    },
    contentShown: (thread: string) => {
      const window = perf;
      if (!window) return;
      const entry = { thread, at: performance.now(), frameAt: null as number | null };
      window.content.push(entry);
      requestAnimationFrame(() => {
        entry.frameAt = performance.now();
      });
    },
  },
});

/** Visits every mounted fiber; `enter` returns the context passed to the fiber's children. */
function walk<C>(fiber: Fiber | null, context: C, enter: (fiber: Fiber, context: C) => C) {
  let node = fiber;
  while (node) {
    const next = enter(node, context);
    if (node.child) walk(node.child, next, enter);
    node = node.sibling;
  }
}

const readAtom = <T>(atom: Atom): T => {
  const { appAtomRegistry } = require("../../state/atom-registry") as {
    appAtomRegistry: { get: (atom: Atom) => unknown };
  };
  return appAtomRegistry.get(atom) as T;
};

/** Mounted thread feeds, the composer text the native editor was given, and the status pill. */
function scanTree() {
  const feeds = new Map<string, Feed>();
  const editors: Array<{ value: string; expanded: boolean }> = [];
  let floatingStatus: string | null = null;
  let homeList: Array<{
    type: string;
    threadId?: string;
    status?: string;
    pinned?: boolean;
    count?: number;
    expanded?: boolean;
  }> | null = null;
  const enter = (fiber: Fiber, feed: Feed | null): Feed | null => {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== "object") return feed;
    if ("listRef" in props && typeof props.threadId === "string" && "detailRef" in props) {
      const existing = feeds.get(props.threadId);
      if (existing) return existing;
      const created: Feed = {
        threadId: props.threadId,
        environmentId: String(props.environmentId),
        list: props.listRef as Feed["list"],
        following: null,
      };
      feeds.set(props.threadId, created);
      return created;
    }
    if (feed && "maintainScrollAtEnd" in props && "maintainVisibleContentPosition" in props)
      feed.following = props.maintainScrollAtEnd !== false;
    if (typeof props.value === "string" && "chipsInert" in props)
      editors.push({ value: props.value, expanded: props.chipsInert === false });
    if ("status" in props && "showScrollToEnd" in props) {
      const status = props.status as { kind?: string } | null;
      floatingStatus = status?.kind ?? null;
    }
    if (homeList === null && Array.isArray(props.data) && "renderItem" in props) {
      const data = props.data as ReadonlyArray<{
        type?: string;
        item?: { thread?: { id?: string }; pinned?: boolean };
        count?: number;
        expanded?: boolean;
      }>;
      if (data.some((entry) => entry?.type?.startsWith("v2-"))) {
        const { resolveThreadListV2Status } = require("../threads/threadListV2") as {
          resolveThreadListV2Status: (thread: unknown) => string;
        };
        homeList = data.map((entry) => ({
          type: String(entry.type),
          ...(entry.item?.thread?.id
            ? {
                threadId: entry.item.thread.id,
                status: resolveThreadListV2Status(entry.item.thread),
                pinned: entry.item.pinned === true,
              }
            : {}),
          ...(typeof entry.count === "number" ? { count: entry.count } : {}),
          ...(typeof entry.expanded === "boolean" ? { expanded: entry.expanded } : {}),
        }));
      }
    }
    return feed;
  };
  for (const root of roots) walk(root.current, null, enter);
  return { feeds: [...feeds.values()], editors, floatingStatus, homeList };
}

function feedState(feed: Feed) {
  const state = feed.list?.current?.getState?.();
  if (!state) return { threadId: feed.threadId, ready: false as const };
  const start = Math.max(0, state.start);
  const end = Math.min(state.data.length - 1, state.end);
  const rows: Record<string, number> = {};
  for (let index = start; index <= end; index++) {
    const row = state.data[index];
    const key = row?.id ?? row?.key;
    if (key) rows[key] = Math.round(state.positionAtIndex(index) - state.scroll);
  }
  return {
    threadId: feed.threadId,
    ready: true as const,
    scroll: Math.round(state.scroll),
    viewport: Math.round(state.scrollLength),
    content: Math.round(state.contentLength),
    fromEnd: Math.round(state.contentLength - state.scroll - state.scrollLength),
    atEnd: state.isAtEnd,
    following: feed.following,
    count: state.data.length,
    /** Screen y of each visible row, keyed by row id. */
    rows,
  };
}

function route() {
  const { rootNavigationRef } =
    require("../../lib/rootNavigation") as typeof import("../../lib/rootNavigation");
  if (!rootNavigationRef.isReady()) return null;
  const current = rootNavigationRef.getCurrentRoute();
  const { workspaceHasColumns } = require("../layout/workspace/workspace-selection-store") as {
    workspaceHasColumns: () => boolean;
  };
  return {
    name: current?.name ?? null,
    params: (current?.params ?? {}) as Record<string, unknown>,
    columns: workspaceHasColumns(),
  };
}

function snapshot() {
  const scan = scanTree();
  const at = route();
  const threadId = typeof at?.params.threadId === "string" ? at.params.threadId : null;
  const environmentId =
    typeof at?.params.environmentId === "string" ? at.params.environmentId : null;
  const threadKey = threadId && environmentId ? `${environmentId}:${threadId}` : null;
  const { composerDraftsAtom } = require("../../state/use-composer-drafts") as {
    composerDraftsAtom: Atom;
  };
  const { threadComposerErrorsAtom } = require("../../state/thread-composer-error") as {
    threadComposerErrorsAtom: Atom;
  };
  const drafts = readAtom<Record<string, { text?: string }>>(composerDraftsAtom);
  const errors = readAtom<Record<string, { message: string }>>(threadComposerErrorsAtom);
  const { KeyboardController } = require("react-native-keyboard-controller") as {
    KeyboardController: { isVisible: () => boolean };
  };
  const feed = visibleFeed(scan.feeds);
  const { environmentThreadShells } = require("../../state/threads") as {
    environmentThreadShells: { threadShellsAtom: Atom };
  };
  const { resolveThreadListV2Status } = require("../threads/threadListV2") as {
    resolveThreadListV2Status: (thread: unknown) => string;
  };
  const shells = readAtom<ReadonlyArray<{ id: string; environmentId: string }>>(
    environmentThreadShells.threadShellsAtom,
  );
  return {
    /** Saved environments the app has threads from. */
    environments: [...new Set(shells.map((shell) => shell.environmentId))],
    /** The app's own status for every thread it knows, including rows folded into a shelf. */
    threads: Object.fromEntries(
      shells.map((shell) => [shell.id, resolveThreadListV2Status(shell)]),
    ),
    route: at,
    feed: feed ? feedState(feed) : null,
    composer: {
      key: threadKey,
      draft: threadKey ? (drafts[threadKey]?.text ?? "") : null,
      drafts: Object.fromEntries(
        Object.entries(drafts).map(([key, draft]) => [key, draft.text ?? ""]),
      ),
      editors: scan.editors,
      error: threadKey ? (errors[threadKey]?.message ?? null) : null,
      keyboard: KeyboardController.isVisible(),
    },
    floatingStatus: scan.floatingStatus,
    homeList: scan.homeList,
  };
}

const frames = { js: [] as number[], on: false };

function jsFrame(time: number) {
  if (!frames.on) return;
  frames.js.push(time);
  requestAnimationFrame(jsFrame);
}

function uiFramesStart() {
  "worklet";
  const ui = globalThis as { __t3UiFrames?: number[]; __t3UiFramesOn?: boolean };
  ui.__t3UiFrames = [];
  ui.__t3UiFramesOn = true;
  const tick = (time: number) => {
    if (!ui.__t3UiFramesOn) return;
    ui.__t3UiFrames!.push(time);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function uiFramesStop() {
  "worklet";
  const ui = globalThis as { __t3UiFrames?: number[]; __t3UiFramesOn?: boolean };
  ui.__t3UiFramesOn = false;
  return ui.__t3UiFrames ?? [];
}

let samples: Array<Record<string, unknown>> = [];
let sampled: Feed | null = null;

// The feed is found once per recording; a tree walk on every frame would itself cause jank.
function sampleFeed(time: number) {
  if (!sampled) return;
  const { following: _following, ...state } = feedState(sampled);
  samples.push({ at: time, ...state });
  requestAnimationFrame(sampleFeed);
}

function visibleFeed(feeds: ReadonlyArray<Feed>) {
  const threadId = route()?.params.threadId;
  return feeds.find((feed) => feed.threadId === threadId) ?? feeds.at(-1) ?? null;
}

installCommitHook();

Object.assign(globalThis, {
  __t3Behavior: {
    open(url: string) {
      const { Linking } = require("react-native") as typeof import("react-native");
      void Linking.openURL(url);
      return true;
    },
    /** Restarts the JS app; deferred so the inspector call can reply first. */
    reload() {
      const { DevSettings } = require("react-native") as typeof import("react-native");
      setTimeout(() => DevSettings.reload(), 100);
      return true;
    },
    state: () => JSON.stringify(snapshot()),
    /** Removes these saved environments (and their cached threads) through the app's own command. */
    async forgetEnvironments(ids: ReadonlyArray<string>) {
      const { runAtomCommand } = require("@t3tools/client-runtime/state/runtime") as {
        runAtomCommand: (
          registry: unknown,
          command: unknown,
          value: unknown,
          options: object,
        ) => Promise<unknown>;
      };
      const { appAtomRegistry } = require("../../state/atom-registry") as {
        appAtomRegistry: unknown;
      };
      const { environmentCatalog } = require("../../connection/catalog") as {
        environmentCatalog: { remove: unknown };
      };
      for (const id of ids)
        await runAtomCommand(appAtomRegistry, environmentCatalog.remove, id, {
          label: "behavior probe",
        });
      return true;
    },
    /** Records JS and UI frame times, and the visible feed on every JS frame. */
    recordStart(withFeed: boolean) {
      const { scheduleOnUI } =
        require("react-native-worklets") as typeof import("react-native-worklets");
      frames.js = [];
      frames.on = true;
      requestAnimationFrame(jsFrame);
      scheduleOnUI(uiFramesStart);
      samples = [];
      sampled = withFeed ? visibleFeed(scanTree().feeds) : null;
      if (sampled) requestAnimationFrame(sampleFeed);
      return true;
    },
    recordStop() {
      const { runOnUISync } =
        require("react-native-worklets") as typeof import("react-native-worklets");
      frames.on = false;
      sampled = null;
      return JSON.stringify({ js: frames.js, ui: runOnUISync(uiFramesStop), feed: samples });
    },
    /** Opens a perf window: inputs, commits, timeline content and frames until `perfStop`. */
    perfStart() {
      perf = { startedAt: performance.now(), inputs: [], commits: [], content: [], keys: [] };
      const counter = globalThis as { __t3RenderCounterStart?: () => boolean };
      counter.__t3RenderCounterStart?.();
      return this.recordStart(false);
    },
    /** Cheap progress of the open window, so the harness can wait for quiet without a tree walk. */
    perfPeek() {
      const window = perf;
      const last = Math.max(
        window?.inputs.at(-1)?.at ?? 0,
        window?.commits.at(-1)?.at ?? 0,
        window?.content.at(-1)?.frameAt ?? 0,
      );
      return JSON.stringify({
        now: performance.now(),
        last,
        inputs: window?.inputs.length ?? 0,
        content: window?.content.flatMap((entry) => (entry.frameAt === null ? [] : [entry.thread])),
      });
    },
    perfStop() {
      const window = perf;
      perf = null;
      const counter = globalThis as { __t3RenderCounterStop?: () => unknown };
      const { js, ui } = JSON.parse(this.recordStop()) as { js: number[]; ui: number[] };
      const hermes = (
        globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }
      ).HermesInternal?.getInstrumentedStats?.();
      return JSON.stringify({
        ...window,
        js,
        ui,
        renders: counter.__t3RenderCounterStop?.() ?? null,
        heapBytes: hermes?.js_heapSize ?? null,
      });
    },
    /** What the app holds: atom registry nodes by label, and mounted fibers by component. */
    retention() {
      const { appAtomRegistry } = require("../../state/atom-registry") as {
        appAtomRegistry: { getNodes: () => ReadonlyMap<unknown, unknown> };
      };
      const atoms = new Map<string, number>();
      for (const key of appAtomRegistry.getNodes().keys()) {
        const label =
          typeof key === "string"
            ? `key:${key.split(/[:/]/)[0]}`
            : ((key as { label?: readonly [string, ...unknown[]] | string }).label ?? "unlabeled");
        const name = Array.isArray(label) ? String(label[0]) : String(label);
        atoms.set(name, (atoms.get(name) ?? 0) + 1);
      }
      const fibers = new Map<string, number>();
      let fiberCount = 0;
      for (const root of roots)
        walk(root.current, null, (fiber) => {
          fiberCount += 1;
          const type = fiber.type as { displayName?: string; name?: string } | string | null;
          const name = typeof type === "string" ? type : (type?.displayName ?? type?.name ?? "");
          if (name) fibers.set(name, (fibers.get(name) ?? 0) + 1);
          return null;
        });
      const top = (map: Map<string, number>) =>
        Object.fromEntries([...map].sort((a, b) => b[1] - a[1]).slice(0, 25));
      return JSON.stringify({
        atomCount: appAtomRegistry.getNodes().size,
        fiberCount,
        atoms: top(atoms),
        fibers: top(fibers),
      });
    },
    /** The Hermes heap, after a full collection when this runtime exposes `gc`. */
    heap() {
      const internal = globalThis as {
        gc?: () => void;
        HermesInternal?: { getInstrumentedStats?: () => Record<string, number> };
      };
      internal.gc?.();
      return JSON.stringify({
        bytes: internal.HermesInternal?.getInstrumentedStats?.().js_heapSize ?? null,
        collected: typeof internal.gc === "function",
      });
    },
  },
});
