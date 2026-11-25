// Scripts scripts/client-metrics.ts runs inside the page. They are strings because they run in
// Chromium, not Node; the shapes they return are decoded with the schemas below.
import * as Schema from "effect/Schema";

import type { Renders } from "./client-metrics-report.ts";

/**
 * Installed before the app loads (`--renders`): a minimal DevTools hook makes production React
 * report commits. Only fibers React rendered are counted: a bailed-out subtree keeps
 * `child === alternate.child`, and PerformedWork (flag 1) is cleared whenever a fiber is cloned.
 */
export const RENDER_PROBE = `(() => {
  const hook = (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
    isDisabled: false,
  });
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (!type || typeof type === "string") return null;
    const inner = type.type ?? type.render ?? type;
    return (type.displayName || inner.displayName || inner.name || "").replace(/^(Forget\\(|Memo\\()+|\\)+$/g, "") || null;
  };
  const isEffect = (value) => value && typeof value === "object" && "create" in value && "deps" in value && "tag" in value;
  // Only state, reducer and store hooks have a queue; memo, callback and ref slots move because something upstream did.
  const changedStateSlot = (previous, next) => {
    let a = previous.memoizedState, b = next.memoizedState;
    for (let slot = 0; a && b && slot < 800; slot++, a = a.next, b = b.next) {
      if (b.queue !== null && !isEffect(b.memoizedState) && !Object.is(a.memoizedState, b.memoizedState)) return slot;
    }
    return -1;
  };
  const diff = (a, b, path, out, depth) => {
    if (Object.is(a, b) || out.length > 20) return;
    if (depth > 4 || !a || !b || typeof a !== "object" || typeof b !== "object") {
      out.push(path + (b && typeof b === "object" ? "(object)" : "=" + String(b).slice(0, 40)));
      return;
    }
    if (a instanceof Map && b instanceof Map) {
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        const at = path + "<" + String(key).slice(0, 20) + ">";
        if (!b.has(key)) out.push(at + "(deleted)");
        else diff(a.get(key), b.get(key), at, out, depth + 1);
      }
      return;
    }
    let any = false;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.is(a[key], b[key])) { any = true; diff(a[key], b[key], path + "." + key, out, depth + 1); }
    }
    if (!any) out.push(path + "(identity only)");
  };
  const state = { on: false, commits: 0, counts: new Map(), causes: new Map(), slotNames: [], slots: [] };
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const visit = (first, parentName) => {
    for (let node = first; node; node = node.sibling) {
      const previous = node.alternate;
      const name = COMPONENT_TAGS.has(node.tag) ? (nameOf(node) ?? "(anonymous)") : null;
      const rendered = name !== null && (node.flags & 1) === 1;
      if (rendered) {
        bump(state.counts, name);
        let cause;
        if (!previous) cause = "mount";
        else {
          const slot = changedStateSlot(previous, node);
          if (slot >= 0) cause = "state#" + slot;
          else if (previous.memoizedProps !== node.memoizedProps) {
            const props = node.memoizedProps ?? {};
            const keys = Object.keys(props).filter((key) => !Object.is(previous.memoizedProps?.[key], props[key]));
            cause = keys.length ? "props:" + keys.slice(0, 4).join(",") : "parent-same-props<-" + parentName;
          } else cause = "context";
          if (state.slotNames.includes(name)) {
            let a = previous.memoizedState, b = node.memoizedState;
            for (let slot = 0; a && b && slot < 600; slot++, a = a.next, b = b.next) {
              if (Object.is(a.memoizedState, b.memoizedState) || isEffect(b.memoizedState)) continue;
              const out = [];
              diff(a.memoizedState, b.memoizedState, "#" + slot, out, 0);
              if (state.slots.length < 200) state.slots.push(name + " " + out.join(" "));
            }
          }
        }
        bump(state.causes, name + " " + cause);
      }
      const skipped = previous !== null && node.child === previous.child && !rendered;
      if (node.child && !skipped) visit(node.child, rendered ? name : parentName);
    }
  };
  const original = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = function (id, root, ...rest) {
    if (state.on) {
      state.commits += 1;
      visit(root.current.child, "root");
    }
    return original(id, root, ...rest);
  };
  const sortedCounts = (map, limit) =>
    [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
  window.__clientMetricsRenders = {
    start(slotNames) {
      Object.assign(state, { on: true, commits: 0, counts: new Map(), causes: new Map(), slotNames: slotNames ?? [], slots: [] });
    },
    stop() {
      state.on = false;
      let renders = 0;
      for (const count of state.counts.values()) renders += count;
      return { commits: state.commits, renders, top: sortedCounts(state.counts, 40), causes: sortedCounts(state.causes, 400), slots: state.slots };
    },
  };
})()`;

const Count = Schema.Struct({ name: Schema.String, count: Schema.Number });
export const ProbeReading = Schema.Struct({
  commits: Schema.Number,
  renders: Schema.Number,
  top: Schema.Array(Count),
  causes: Schema.Array(Count),
  slots: Schema.Array(Schema.String),
});
export type ProbeReading = typeof ProbeReading.Type;

/** What the result file keeps of a probe reading; the full one goes to the artifacts. */
export const rendersOf = (reading: ProbeReading, keep = 12): Renders => ({
  commits: reading.commits,
  renders: reading.renders,
  top: reading.top.slice(0, keep),
  causes: reading.causes.slice(0, keep),
});

/**
 * The open right-panel surface's DOM: node counts, and the path down its largest children with
 * the tags that dominate, to say what makes a panel heavy.
 */
export const DOM_CENSUS = `(() => {
  const all = document.getElementsByTagName("*").length;
  const panel = document.querySelector("[data-right-panel-surface-content]");
  if (!panel) return { documentNodes: all, panelNodes: 0, svg: 0, svgChildren: 0, buttons: 0, codeTokens: 0, tags: [], path: [] };
  const size = (element) => element.getElementsByTagName("*").length + 1;
  const describe = (element) => {
    const data = [...element.attributes].filter((attribute) => attribute.name.startsWith("data-")).slice(0, 3).map((attribute) => "[" + attribute.name + "]").join("");
    const classes = (element.getAttribute("class") ?? "").split(" ").filter(Boolean).slice(0, 3).map((name) => "." + name).join("");
    return element.tagName.toLowerCase() + data + classes;
  };
  const path = [];
  let cursor = panel;
  for (let depth = 0; depth < 8; depth++) {
    const children = [...cursor.children].map((child) => [child, size(child)]).sort((a, b) => b[1] - a[1]);
    path.push({ node: describe(cursor), nodes: size(cursor), children: children.slice(0, 6).map(([child, nodes]) => ({ node: describe(child), nodes })) });
    if (children.length === 0) break;
    cursor = children[0][0];
  }
  const tags = new Map();
  for (const element of panel.getElementsByTagName("*")) {
    const tag = element.tagName.toLowerCase();
    tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return {
    documentNodes: all,
    panelNodes: size(panel),
    svg: panel.querySelectorAll("svg").length,
    svgChildren: panel.querySelectorAll("svg *").length,
    buttons: panel.querySelectorAll("button").length,
    codeTokens: panel.querySelectorAll("pre *").length,
    tags: [...tags].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([tag, count]) => ({ name: tag, count })),
    path,
  };
})()`;

export const Census = Schema.Struct({
  documentNodes: Schema.Number,
  panelNodes: Schema.Number,
  svg: Schema.Number,
  svgChildren: Schema.Number,
  buttons: Schema.Number,
  codeTokens: Schema.Number,
  tags: Schema.Array(Count),
  path: Schema.Array(
    Schema.Struct({
      node: Schema.String,
      nodes: Schema.Number,
      children: Schema.Array(Schema.Struct({ node: Schema.String, nodes: Schema.Number })),
    }),
  ),
});
