export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One node of an agent-device `snapshot --json`, on iOS or Android. */
export interface SnapshotNode {
  readonly index: number;
  readonly parentIndex?: number;
  /** Valid for commands until the next snapshot. */
  readonly ref?: string;
  readonly kind?: string;
  readonly type?: string;
  readonly label?: string;
  readonly identifier?: string;
  readonly rect?: Rect;
  readonly hittable?: boolean;
  readonly editable?: boolean;
  readonly bundleId?: string;
  readonly systemBar?: string;
}

export interface Snapshot {
  readonly nodes: ReadonlyArray<SnapshotNode>;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly appBundleId?: string;
  readonly keyboard?: { readonly kind?: string; readonly rect?: Rect };
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export const check = (name: string, pass: boolean, detail: string): Check => ({
  name,
  pass,
  detail,
});

// Kinds that are never controls a person taps; iOS also marks plain text hittable.
const NOT_CONTROLS = new Set([
  "application",
  "text",
  "image",
  "scroll-area",
  "other",
  "toolbar",
  "tab-bar",
  "activity-indicator",
  "composeview",
  "keyboard",
]);

const area = (rect: Rect) => Math.max(0, rect.width) * Math.max(0, rect.height);

const intersection = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export const describeRect = (rect: Rect | undefined) =>
  rect
    ? `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}`
    : "absent";

const name = (node: SnapshotNode) => node.label || node.identifier || node.type || "unlabelled";

const appOwned = (node: SnapshotNode, snapshot: Snapshot) =>
  !node.systemBar && (node.bundleId === undefined || node.bundleId === snapshot.appBundleId);

const isControl = (node: SnapshotNode, snapshot: Snapshot) =>
  node.hittable === true &&
  node.rect !== undefined &&
  area(node.rect) > 0 &&
  !NOT_CONTROLS.has(node.kind ?? "") &&
  appOwned(node, snapshot);

function ancestors(node: SnapshotNode, snapshot: Snapshot): SnapshotNode[] {
  const byIndex = new Map(snapshot.nodes.map((candidate) => [candidate.index, candidate]));
  const chain: SnapshotNode[] = [];
  for (let parent = node.parentIndex; parent !== undefined;) {
    const next = byIndex.get(parent);
    if (!next || chain.includes(next)) break;
    chain.push(next);
    parent = next.parentIndex;
  }
  return chain;
}

const viewportRect = (snapshot: Snapshot): Rect => ({ x: 0, y: 0, ...snapshot.viewport });

export function keyboardRect(snapshot: Snapshot): Rect | undefined {
  if (snapshot.keyboard?.rect) return snapshot.keyboard.rect;
  return snapshot.nodes.find((node) => node.type === "Keyboard" || node.kind === "keyboard")?.rect;
}

const TAB_LABELS = new Set(["Chats", "Pulls", "Usage", "Settings"]);

/** The bottom tab bar, as a native tab bar node or the union of its tab buttons. */
export function tabBarRect(snapshot: Snapshot): Rect | undefined {
  const native = snapshot.nodes.find((node) => node.kind === "tab-bar" && node.rect)?.rect;
  if (native) return native;
  const tabs = snapshot.nodes.filter(
    (node) =>
      node.rect &&
      TAB_LABELS.has(node.label ?? "") &&
      node.rect.y > snapshot.viewport.height * 0.7 &&
      appOwned(node, snapshot),
  );
  if (tabs.length < 2) return undefined;
  const left = Math.min(...tabs.map((tab) => tab.rect!.x));
  const top = Math.min(...tabs.map((tab) => tab.rect!.y));
  const right = Math.max(...tabs.map((tab) => tab.rect!.x + tab.rect!.width));
  const bottom = Math.max(...tabs.map((tab) => tab.rect!.y + tab.rect!.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const ERROR_TEXT =
  /\b(Render Error|Uncaught Error|Unhandled JS Exception|Syntax Error|keeps stopping|isn't responding)\b/i;

/**
 * Checks every screen should pass, whatever it shows: the app is in front without an error
 * screen, and no control is clipped by the screen edge, stacked on another control, under a
 * system bar, or an input under the keyboard.
 */
export function layoutChecks(snapshot: Snapshot, bundleId: string): Check[] {
  const viewport = viewportRect(snapshot);
  const controls = snapshot.nodes.filter((node) => isControl(node, snapshot));
  const errors = snapshot.nodes.filter((node) => ERROR_TEXT.test(node.label ?? ""));

  const clipped = controls.filter((node) => {
    const visible = intersection(node.rect!, viewport);
    if (visible === 0 || visible >= area(node.rect!) * 0.98) return false;
    // Content scrolled past the edge is expected; fixed chrome cut off by it is not.
    return !ancestors(node, snapshot).some((parent) => parent.kind === "scroll-area");
  });

  // Only siblings: a screen covered by another stays in the tree, so cousins overlap
  // legitimately. Native tab items report overlapping frames.
  const siblings = controls.filter(
    (node) => !ancestors(node, snapshot).some((parent) => parent.kind === "tab-bar"),
  );
  const stacked: string[] = [];
  for (const [index, a] of siblings.entries()) {
    for (const b of siblings.slice(index + 1)) {
      if (a.parentIndex !== b.parentIndex) continue;
      const shared = intersection(a.rect!, b.rect!);
      if (shared < Math.min(area(a.rect!), area(b.rect!)) * 0.25) continue;
      // iOS exposes some elements twice, at the same frame.
      const same =
        describeRect(a.rect) === describeRect(b.rect) &&
        (!a.label || !b.label || a.label === b.label);
      if (!same) stacked.push(`"${name(a)}" and "${name(b)}"`);
    }
  }

  const bars = snapshot.nodes.filter((node) => node.systemBar && node.rect);
  const underBars = controls.filter((node) =>
    bars.some((bar) => intersection(node.rect!, bar.rect!) > area(node.rect!) * 0.3),
  );

  const keyboard = keyboardRect(snapshot);
  const coveredInputs = keyboard
    ? snapshot.nodes.filter(
        (node) =>
          (node.kind === "text-field" || node.editable === true) &&
          node.rect &&
          appOwned(node, snapshot) &&
          intersection(node.rect, keyboard) > area(node.rect) * 0.3,
      )
    : [];

  const list = (nodes: ReadonlyArray<SnapshotNode>) =>
    nodes.map((node) => `"${name(node)}" at ${describeRect(node.rect)}`).join(", ");
  return [
    check(
      "app in front",
      snapshot.appBundleId === undefined || snapshot.appBundleId === bundleId,
      snapshot.appBundleId ?? "unknown",
    ),
    check("no error screen", errors.length === 0, errors.map(name).join(", ") || "none"),
    check("no control cut off by the screen edge", clipped.length === 0, list(clipped) || "none"),
    check("no controls stacked on each other", stacked.length === 0, stacked.join("; ") || "none"),
    check("no control under a system bar", underBars.length === 0, list(underBars) || "none"),
    check(
      "no input under the keyboard",
      coveredInputs.length === 0,
      keyboard ? list(coveredInputs) || "none" : "no keyboard",
    ),
  ];
}

export const findLabel = (snapshot: Snapshot, pattern: RegExp) =>
  snapshot.nodes.find(
    (node) =>
      node.rect &&
      pattern.test(node.label ?? "") &&
      intersection(node.rect, viewportRect(snapshot)) > 0 &&
      appOwned(node, snapshot),
  );
