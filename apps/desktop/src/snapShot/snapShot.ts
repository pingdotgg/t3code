// @effect-diagnostics globalTimers:off -- The Electron window-blur handshake uses a native timeout outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only platform check reads procfs and resolves Wayland socket paths with Node.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  SNAP_SHOT_ACCESSIBILITY_MAX_NODES,
  SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS,
  isModifierPairShortcut,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
  type SnapShotAccessibilityNode,
  type SnapShotKeyChord,
  type SnapShotModifier,
  type SnapShotShortcut,
} from "@t3tools/contracts";

interface AccessibilityTreeNode {
  readonly name?: string;
  readonly value?: string;
  readonly children: ReadonlyArray<AccessibilityTreeNode>;
}

const MAX_ACCESSIBILITY_TREE_NODES = 10_000;
const WINDOW_BLUR_TIMEOUT_MS = 1_000;

/** Win32 virtual-key codes for the left and right key of each modifier pair. */
export const WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS: Record<
  SnapShotModifier,
  readonly [number, number]
> = {
  shift: [0xa0, 0xa1],
  control: [0xa2, 0xa3],
  alt: [0xa4, 0xa5],
  meta: [0x5b, 0x5c],
};

export function snapShotShortcutRegistrationFailureMessage(
  shortcut: SnapShotShortcut,
  platform: NodeJS.Platform,
): string {
  return isModifierPairShortcut(shortcut)
    ? `${snapShotModifierPairLabel(
        snapShotShortcutModifierPair(shortcut),
        platform === "darwin",
      )} is not available on this system.`
    : "This shortcut is already used by the system or another app.";
}

const COMMON_MOD_ACTIONS: Readonly<Record<string, string>> = {
  a: "Select All",
  c: "Copy",
  f: "Find",
  n: "New",
  o: "Open",
  p: "Print",
  q: "Quit",
  s: "Save",
  t: "New Tab",
  v: "Paste",
  w: "Close Window",
  x: "Cut",
  z: "Undo",
};

export function snapShotShortcutSystemConflict(shortcut: SnapShotKeyChord): string | null {
  const modifierCount = [
    shortcut.modKey,
    shortcut.metaKey,
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
  ].filter(Boolean).length;
  if (modifierCount !== 1) return null;
  if (shortcut.shiftKey) {
    return "Shift combinations are used for typing and text selection. Add another modifier.";
  }
  const key = shortcut.key.toLowerCase();
  if (shortcut.modKey) {
    const action = COMMON_MOD_ACTIONS[key];
    return action ? `This shortcut is ${action} in most apps.` : null;
  }
  if (shortcut.ctrlKey && ["c", "d", "z"].includes(key)) {
    return "This shortcut controls running commands in terminals.";
  }
  if (shortcut.altKey && key === "tab") return "The system uses Alt+Tab to switch apps.";
  if (shortcut.metaKey && ["l", " "].includes(key)) {
    return "The system already uses this shortcut.";
  }
  return null;
}

export function accessibleWindowText(root: AccessibilityTreeNode, maxChars: number): string {
  const seen = new Set<string>();
  const stack = [root];
  let text = "";
  let visited = 0;
  while (stack.length > 0 && text.length < maxChars && visited < MAX_ACCESSIBILITY_TREE_NODES) {
    const node = stack.pop()!;
    visited += 1;
    for (const value of [node.name, node.value]) {
      const candidate = value?.replaceAll("\0", "").trim();
      if (!candidate || seen.has(candidate)) continue;

      const separator = text ? "\n" : "";
      const remaining = maxChars - text.length - separator.length;
      if (remaining <= 0) return text;
      const candidateEnd =
        candidate.length <= remaining
          ? candidate.length
          : /[\uD800-\uDBFF]/.test(candidate[remaining - 1] ?? "")
            ? remaining - 1
            : remaining;
      if (candidateEnd === 0) return text;
      text += separator + candidate.slice(0, candidateEnd);
      if (candidateEnd < candidate.length) return text;
      seen.add(candidate);
    }
    stack.push(...node.children.toReversed());
  }
  return text;
}

type AccessibilityElement = {
  readonly role?: string;
  readonly name?: string | null;
  readonly value?: string | null;
  readonly description?: string | null;
  readonly bounds?: WindowBounds | null;
  readonly actions?: ReadonlyArray<string>;
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly checked?: "on" | "off" | "mixed" | null;
  readonly editable?: boolean;
  readonly enabled?: boolean;
  readonly expanded?: boolean | null;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly visible?: boolean;
  readonly children?: () => Promise<ReadonlyArray<AccessibilityElement>>;
};

type MutableAccessibilityNode = Omit<SnapShotAccessibilityNode, "children"> & {
  children: Array<MutableAccessibilityNode>;
};

type CapturedImageSize = { readonly width: number; readonly height: number };

function safeProperty<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function boundedSnapShotString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.replaceAll("\0", "").trim();
  if (!candidate) return undefined;
  if (candidate.length <= maxChars) return candidate;
  const end = /[\uD800-\uDBFF]/.test(candidate[maxChars - 1] ?? "") ? maxChars - 1 : maxChars;
  return candidate.slice(0, end).trimEnd();
}

export function capturedImageBounds(
  bounds: WindowBounds | null | undefined,
  sourceBounds: WindowBounds,
  imageSize: CapturedImageSize,
): SnapShotAccessibilityNode["bounds"] {
  if (
    bounds === null ||
    bounds === undefined ||
    sourceBounds.width <= 0 ||
    sourceBounds.height <= 0 ||
    imageSize.width <= 0 ||
    imageSize.height <= 0 ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
  ) {
    return null;
  }
  const scaleX = imageSize.width / sourceBounds.width;
  const scaleY = imageSize.height / sourceBounds.height;
  const left = Math.max(0, Math.round((bounds.x - sourceBounds.x) * scaleX));
  const top = Math.max(0, Math.round((bounds.y - sourceBounds.y) * scaleY));
  const right = Math.min(
    imageSize.width,
    Math.round((bounds.x + bounds.width - sourceBounds.x) * scaleX),
  );
  const bottom = Math.min(
    imageSize.height,
    Math.round((bounds.y + bounds.height - sourceBounds.y) * scaleY),
  );
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function accessibilityNode(
  element: AccessibilityElement,
  elementBounds: WindowBounds | null | undefined,
  sourceBounds: WindowBounds,
  imageSize: CapturedImageSize,
  isRoot: boolean,
  locationsReliable: boolean,
): MutableAccessibilityNode {
  const name = boundedSnapShotString(
    safeProperty(() => element.name),
    1_000,
  );
  const value = boundedSnapShotString(
    safeProperty(() => element.value),
    8_000,
  );
  const description = boundedSnapShotString(
    safeProperty(() => element.description),
    2_000,
  );
  const checked = safeProperty(() => element.checked);
  const expanded = safeProperty(() => element.expanded);
  const state = {
    ...(safeProperty(() => element.active) === true ? { active: true } : {}),
    ...(safeProperty(() => element.busy) === true ? { busy: true } : {}),
    ...(checked === "on" || checked === "off" || checked === "mixed" ? { checked } : {}),
    ...(safeProperty(() => element.editable) === true ? { editable: true } : {}),
    ...(safeProperty(() => element.enabled) === false ? { enabled: false } : {}),
    ...(typeof expanded === "boolean" ? { expanded } : {}),
    ...(safeProperty(() => element.focused) === true ? { focused: true } : {}),
    ...(safeProperty(() => element.selected) === true ? { selected: true } : {}),
    ...(safeProperty(() => element.visible) === false ? { visible: false } : {}),
  };
  const actions = Array.from(
    new Set(
      (safeProperty(() => element.actions) ?? [])
        .map((action) => boundedSnapShotString(action, 100))
        .filter((action): action is string => action !== undefined),
    ),
  ).slice(0, 32);
  return {
    role:
      boundedSnapShotString(
        safeProperty(() => element.role),
        100,
      ) ?? "unknown",
    ...(name ? { name } : {}),
    ...(value && value !== name ? { value } : {}),
    ...(description && description !== name && description !== value ? { description } : {}),
    bounds: isRoot
      ? { x: 0, y: 0, width: imageSize.width, height: imageSize.height }
      : locationsReliable
        ? capturedImageBounds(elementBounds, sourceBounds, imageSize)
        : null,
    ...(Object.keys(state).length > 0 ? { state } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    children: [],
  };
}

function isAnonymousGroup(node: SnapShotAccessibilityNode): boolean {
  return (
    node.role === "group" &&
    node.name === undefined &&
    node.value === undefined &&
    node.description === undefined &&
    node.state === undefined &&
    node.actions === undefined
  );
}

function compactAccessibilityNodes(
  node: SnapShotAccessibilityNode,
  isRoot: boolean,
  descendantLocationsReliable: boolean,
): Array<MutableAccessibilityNode> {
  const children = node.children.flatMap((child) =>
    compactAccessibilityNodes(child, false, descendantLocationsReliable),
  );
  const compacted: MutableAccessibilityNode = {
    ...node,
    ...(!isRoot && !descendantLocationsReliable ? { bounds: null } : {}),
    children,
  };
  if (!isRoot && isAnonymousGroup(compacted)) {
    if (children.length === 0) return [];
    if (children.length === 1) return children;
  }
  return [compacted];
}

export function compactAccessibilityTree(
  root: SnapShotAccessibilityNode,
  options: { readonly descendantLocationsReliable?: boolean } = {},
): {
  readonly root: SnapShotAccessibilityNode;
  readonly truncated: boolean;
} {
  const compactedRoot = compactAccessibilityNodes(
    root,
    true,
    options.descendantLocationsReliable !== false,
  )[0]!;
  let nodes = 0;
  let serializedChars = 256;
  let truncated = false;

  const visit = (
    node: SnapShotAccessibilityNode,
    required: boolean,
  ): MutableAccessibilityNode | undefined => {
    const copy: MutableAccessibilityNode = { ...node, children: [] };
    const nodeChars = JSON.stringify(copy).length + 1;
    if (
      !required &&
      (nodes >= SNAP_SHOT_ACCESSIBILITY_MAX_NODES ||
        serializedChars + nodeChars > SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS)
    ) {
      truncated = true;
      return undefined;
    }
    nodes += 1;
    serializedChars += nodeChars;
    for (const child of node.children) {
      const childCopy = visit(child, false);
      if (!childCopy) break;
      copy.children.push(childCopy);
    }
    return copy;
  };

  return { root: visit(compactedRoot, true)!, truncated };
}

type AccessibleWindowElementTreeOptions = {
  readonly locationsReliable?: boolean;
  readonly onProgress?: (
    root: SnapShotAccessibilityNode,
    truncated: boolean,
    descendantLocationsReliable: boolean,
  ) => void;
  readonly shouldContinue?: () => boolean;
  readonly verifyDescendantLocations?: boolean;
};

export async function accessibleWindowElementTree(
  element: AccessibilityElement,
  sourceBounds: WindowBounds,
  imageSize: CapturedImageSize,
  options: AccessibleWindowElementTreeOptions = {},
): Promise<{ readonly root: SnapShotAccessibilityNode; readonly truncated: boolean } | undefined> {
  if (typeof element.children !== "function") return undefined;
  let nodes = 0;
  let truncated = false;
  let root: MutableAccessibilityNode | undefined;
  const shouldContinue = options.shouldContinue ?? (() => true);
  let descendantLocationVaries = false;
  let rootBounds = sourceBounds;

  const descendantLocationsReliable = () =>
    options.locationsReliable !== false &&
    (options.verifyDescendantLocations !== true || descendantLocationVaries);

  const visit = async (
    current: AccessibilityElement,
    required: boolean,
  ): Promise<MutableAccessibilityNode | undefined> => {
    if (!shouldContinue()) {
      truncated = true;
      return undefined;
    }
    if (nodes >= SNAP_SHOT_ACCESSIBILITY_MAX_NODES) {
      truncated = true;
      return undefined;
    }
    const elementBounds = safeProperty(() => current.bounds);
    if (required && elementBounds) rootBounds = elementBounds;
    if (
      !required &&
      elementBounds !== null &&
      elementBounds !== undefined &&
      (Math.abs(elementBounds.x - rootBounds.x) > 2 || Math.abs(elementBounds.y - rootBounds.y) > 2)
    ) {
      descendantLocationVaries = true;
    }
    const node = accessibilityNode(
      current,
      elementBounds,
      sourceBounds,
      imageSize,
      required,
      options.locationsReliable !== false,
    );
    nodes += 1;
    root ??= node;
    options.onProgress?.(root, true, descendantLocationsReliable());

    const readChildren = safeProperty(() => current.children);
    if (typeof readChildren !== "function") return node;
    let children: ReadonlyArray<AccessibilityElement>;
    try {
      children = await readChildren.call(current);
    } catch {
      truncated = true;
      return node;
    }
    if (!shouldContinue()) {
      truncated = true;
      return node;
    }
    for (const child of children) {
      const childNode = await visit(child, false);
      if (!childNode) break;
      node.children.push(childNode);
      options.onProgress?.(root, true, descendantLocationsReliable());
    }
    return node;
  };

  const completedRoot = await visit(element, true);
  if (!completedRoot) return undefined;
  const locationsReliable = descendantLocationsReliable();
  const compacted = compactAccessibilityTree(completedRoot, {
    descendantLocationsReliable: locationsReliable,
  });
  const completedTruncated = truncated || compacted.truncated;
  options.onProgress?.(compacted.root, completedTruncated, locationsReliable);
  return { root: compacted.root, truncated: completedTruncated };
}

export function hideAndWaitForBlur(window: {
  readonly hide: () => void;
  readonly once: (event: "blur", listener: () => void) => unknown;
  readonly removeListener: (event: "blur", listener: () => void) => unknown;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeListener("blur", onBlur);
      reject(new Error("Timed out waiting for T3 Code to lose focus."));
    }, WINDOW_BLUR_TIMEOUT_MS);
    const onBlur = () => {
      clearTimeout(timeout);
      resolve();
    };
    window.once("blur", onBlur);
    window.hide();
  });
}

type WindowBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function findAccessibleWindow<
  T extends {
    readonly name: string | null;
    readonly bounds: WindowBounds | null;
    readonly active?: boolean;
  },
>(
  windows: readonly T[],
  captured: {
    readonly title: string;
    readonly sourceTitle?: string;
    readonly bounds: WindowBounds;
    readonly clientBounds?: WindowBounds | undefined;
  },
  matchMode: "screen-bounds" | "wayland" = "screen-bounds",
): T | undefined {
  const normalizeTitle = (value: string) => {
    const title = value.trim();
    // Terminal apps can animate a leading CLI spinner between capture and AT-SPI lookup.
    return matchMode === "wayland" ? title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s+|$)/u, "") : title;
  };
  const titles = new Set(
    [captured.title, captured.sourceTitle ?? ""].map(normalizeTitle).filter(Boolean),
  );
  if (titles.size === 0) return undefined;
  // Wayland accessibility providers can expose window size without a screen position.
  const boundsKeys =
    matchMode === "wayland"
      ? (["width", "height"] as const)
      : (["x", "y", "width", "height"] as const);
  const candidateBounds =
    matchMode === "wayland" && captured.clientBounds
      ? [captured.bounds, captured.clientBounds]
      : [captured.bounds];
  const matches = windows.filter((window) => {
    const bounds = window.bounds;
    return (
      titles.has(normalizeTitle(window.name ?? "")) &&
      bounds !== null &&
      candidateBounds.some((candidate) =>
        boundsKeys.every((key) => Math.abs(bounds[key] - candidate[key]) <= 2),
      )
    );
  });
  if (matches.length === 1) return matches[0];
  const activeMatches = matches.filter((window) => safeProperty(() => window.active) === true);
  return activeMatches.length === 1 ? activeMatches[0] : undefined;
}

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  "+": "Plus",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Escape: "Esc",
};

/** Two shortcuts are the same when they would register the same listener. */
export function sameSnapShotShortcut(left: SnapShotShortcut, right: SnapShotShortcut): boolean {
  if (isModifierPairShortcut(left) || isModifierPairShortcut(right)) {
    return (
      isModifierPairShortcut(left) &&
      isModifierPairShortcut(right) &&
      snapShotShortcutModifierPair(left) === snapShotShortcutModifierPair(right)
    );
  }
  return toElectronAccelerator(left) === toElectronAccelerator(right);
}

export function toElectronAccelerator(shortcut: SnapShotKeyChord): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("CommandOrControl");
  if (shortcut.metaKey) parts.push("Super");
  if (shortcut.ctrlKey) parts.push("Control");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key.toUpperCase());
  return parts.join("+");
}

interface CaptureSourceLike {
  readonly id: string;
  readonly name: string;
}

interface ActiveWindowLike {
  readonly id: number;
  readonly title: string;
}

export function findCaptureSource<T extends CaptureSourceLike>(
  sources: readonly T[],
  activeWindow: ActiveWindowLike,
): T | undefined {
  const idPrefix = `window:${activeWindow.id}:`;
  const idMatch = sources.find((source) => source.id.startsWith(idPrefix));
  if (idMatch) return idMatch;

  const title = activeWindow.title.trim();
  if (!title) return undefined;
  const titleMatches = sources.filter((source) => source.name.trim() === title);
  return titleMatches.length === 1 ? titleMatches[0] : undefined;
}

export function isWaylandSession(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (platform !== "linux") return false;
  if (
    environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
    Boolean(environment.WAYLAND_DISPLAY)
  ) {
    return true;
  }
  if (environment.XDG_SESSION_TYPE?.toLowerCase() === "x11") return false;
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  if (!runtimeDirectory) return false;
  try {
    const liveSockets = new Set(
      NodeFS.readFileSync("/proc/net/unix", "utf8")
        .split("\n")
        .flatMap((line) => line.match(/\s(\/.*)$/)?.[1] ?? []),
    );
    return NodeFS.readdirSync(runtimeDirectory, { withFileTypes: true }).some(
      (entry) =>
        /^wayland-\d+$/.test(entry.name) &&
        entry.isSocket() &&
        liveSockets.has(NodePath.join(runtimeDirectory, entry.name)),
    );
  } catch {
    return false;
  }
}
