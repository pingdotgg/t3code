// Load before React to wrap commits. Skip bailed-out child === alternate.child subtrees; PerformedWork marks rendered fibers.

interface Fiber {
  readonly tag: number;
  readonly type: unknown;
  readonly flags: number;
  readonly alternate: Fiber | null;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly memoizedProps: Record<string, unknown> | null;
  readonly memoizedState: HookSlot | null;
}
interface HookSlot {
  readonly memoizedState: unknown;
  /** Non-null only for useState and useReducer, the hooks that can schedule a render. */
  readonly queue: unknown;
  readonly next: HookSlot | null;
}
interface DevToolsHook {
  onCommitFiberRoot?: (id: unknown, root: { current: Fiber }, ...rest: unknown[]) => unknown;
  __t3RenderCounter?: true;
}
interface RenderCounterState {
  on: boolean;
  commits: number;
  counts: Map<string, number>;
  causes: Map<string, number>;
}
export interface RenderCounterReport {
  readonly commits: number;
  readonly totalRenders: number;
  readonly components: ReadonlyArray<{ key: string; count: number }>;
  readonly causes: ReadonlyArray<{ key: string; count: number }>;
}

const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
const PERFORMED_WORK = 1;

function nameOf(fiber: Fiber): string | null {
  const type = fiber.type as {
    displayName?: string;
    name?: string;
    type?: { displayName?: string; name?: string };
    render?: { displayName?: string; name?: string };
  } | null;
  if (!type || typeof type === "string") return null;
  const inner = type.type ?? type.render ?? type;
  const raw = type.displayName || inner.displayName || inner.name || "";
  return raw.replace(/^(Forget\(|Memo\()+|\)+$/g, "") || null;
}

function isEffect(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "create" in value &&
    "deps" in value &&
    "tag" in value
  );
}

function changedStateSlot(alternate: Fiber, node: Fiber): number {
  let a = alternate.memoizedState;
  let b = node.memoizedState;
  for (let index = 0; a && b && index < 800; index++) {
    const before = a.memoizedState;
    const after = b.memoizedState;
    // Only state updates cause renders; memo, callback and ref changes are consequences.
    if (b.queue !== null && !isEffect(after) && !Object.is(before, after)) return index;
    a = a.next;
    b = b.next;
  }
  return -1;
}

function causeOf(node: Fiber, parentName: string): string {
  const alternate = node.alternate;
  if (!alternate) return "mount";
  const slot = changedStateSlot(alternate, node);
  if (slot >= 0) return `state#${slot}`;
  if (alternate.memoizedProps !== node.memoizedProps) {
    const props = node.memoizedProps ?? {};
    const keys = Object.keys(props).filter(
      (key) => !Object.is(alternate.memoizedProps?.[key], props[key]),
    );
    return keys.length ? `props:${keys.slice(0, 4).join(",")}` : `parent-same-props<-${parentName}`;
  }
  return "context";
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function install(state: RenderCounterState) {
  const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || typeof hook.onCommitFiberRoot !== "function") {
    setTimeout(() => install(state), 50);
    return;
  }
  if (hook.__t3RenderCounter) return;
  hook.__t3RenderCounter = true;
  const original = hook.onCommitFiberRoot.bind(hook);

  const visit = (fiber: Fiber | null, parentName: string) => {
    let node = fiber;
    while (node) {
      const alternate = node.alternate;
      const name = COMPONENT_TAGS.has(node.tag) ? nameOf(node) : null;
      const rendered = name !== null && (node.flags & PERFORMED_WORK) === PERFORMED_WORK;
      if (rendered) {
        increment(state.counts, name);
        increment(state.causes, `${name} ${causeOf(node, parentName)}`);
      }
      const skipped = alternate !== null && node.child === alternate.child && !rendered;
      if (node.child && !skipped) visit(node.child, rendered ? name : parentName);
      node = node.sibling;
    }
  };

  hook.onCommitFiberRoot = (id, root, ...rest) => {
    if (state.on) {
      state.commits += 1;
      visit(root.current.child, "root");
    }
    return original(id, root, ...rest);
  };
}

const state: RenderCounterState = { on: false, commits: 0, counts: new Map(), causes: new Map() };

const sorted = (map: Map<string, number>) =>
  [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);

install(state);

Object.assign(globalThis, {
  __t3RenderCounterOpen(url: string) {
    const { Linking } = require("react-native") as typeof import("react-native");
    void Linking.openURL(url);
    return true;
  },
  /** Restarts the JS app on Home; deferred so the inspector call can reply first. */
  __t3RenderCounterReload() {
    const { DevSettings } = require("react-native") as typeof import("react-native");
    setTimeout(() => DevSettings.reload(), 100);
    return true;
  },
  __t3RenderCounterStart() {
    state.commits = 0;
    state.counts = new Map();
    state.causes = new Map();
    state.on = true;
    return true;
  },
  __t3RenderCounterStop(): RenderCounterReport {
    state.on = false;
    const components = sorted(state.counts);
    return {
      commits: state.commits,
      totalRenders: components.reduce((total, entry) => total + entry.count, 0),
      components,
      causes: sorted(state.causes),
    };
  },
});
