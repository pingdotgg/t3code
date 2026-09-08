// @effect-diagnostics globalTimers:off -- Accessibility timeouts run outside Effect fibers.

import {
  SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS,
  type SnapShotAccessibility,
} from "@t3tools/contracts";
import type * as Electron from "electron";

import {
  accessibleWindowElementTree,
  accessibleWindowText,
  compactAccessibilityTree,
  findAccessibleWindow,
  isWaylandSession,
} from "./snapShot.ts";

const ACCESSIBILITY_TIMEOUT_MS = 3_000;

export type AccessibleWindowIdentity = {
  readonly title: string;
  readonly bounds: Electron.Rectangle;
  readonly clientBounds?: Electron.Rectangle;
  readonly owner: { readonly processId: number };
  readonly accessibilityBoundsReliable?: boolean;
};

export type CapturedWindowAccessibilityContext = {
  readonly accessibleText?: string;
  readonly accessibility?: SnapShotAccessibility;
};

export type SnapShotAccessibilityRequest = {
  readonly active: AccessibleWindowIdentity;
  readonly platform: NodeJS.Platform;
  readonly sourceTitle: string;
  readonly imageSize: Electron.Size;
};

type AccessibilityApp = (typeof import("@crowecawcaw/xa11y"))["App"];

type AccessibilityReadProgress = {
  accessibleText: string | undefined;
  flatComplete: boolean;
  richComplete: boolean;
  richLocationsReliable: boolean;
  richRoot?: Extract<SnapShotAccessibility, { format: "element-tree" }>["root"];
  richTruncated: boolean;
  timedOut: boolean;
};

function accessibilityReadSnapshot(
  progress: AccessibilityReadProgress,
  imageSize: Electron.Size,
): CapturedWindowAccessibilityContext | undefined {
  const richTree = progress.richRoot
    ? compactAccessibilityTree(progress.richRoot, {
        descendantLocationsReliable: progress.richLocationsReliable,
      })
    : undefined;
  const accessibleText =
    progress.accessibleText ??
    (richTree
      ? accessibleWindowText(richTree.root, SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS)
      : undefined);
  const accessibility: SnapShotAccessibility | undefined =
    progress.richComplete && richTree
      ? {
          format: "element-tree",
          coordinateSpace: "captured-image",
          imageSize,
          truncated: progress.richTruncated || richTree.truncated,
          root: richTree.root,
        }
      : progress.flatComplete && accessibleText
        ? {
            format: "flat-text",
            text: accessibleText,
            truncated: accessibleText.length >= SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS,
          }
        : richTree
          ? {
              format: "element-tree",
              coordinateSpace: "captured-image",
              imageSize,
              truncated: true,
              root: richTree.root,
            }
          : undefined;
  if (!accessibleText && !accessibility) return undefined;
  return JSON.parse(
    JSON.stringify({
      ...(accessibleText ? { accessibleText } : {}),
      ...(accessibility ? { accessibility } : {}),
    }),
  ) as CapturedWindowAccessibilityContext;
}

async function readCapturedWindowAccessibility(
  App: AccessibilityApp,
  request: SnapShotAccessibilityRequest,
  progress: AccessibilityReadProgress,
  onStarted: () => void,
): Promise<CapturedWindowAccessibilityContext | undefined> {
  const { active, platform, sourceTitle, imageSize } = request;
  const foreground = platform === "win32" ? await App.foreground({ timeout: 0 }) : undefined;
  const windows =
    foreground !== undefined
      ? foreground.pid === active.owner.processId
        ? [foreground.asElement()]
        : []
      : await (await App.byPid(active.owner.processId, { timeout: 0 })).children();
  const matchMode = isWaylandSession(platform, process.env) ? "wayland" : "screen-bounds";
  const window = findAccessibleWindow(
    windows,
    { title: active.title, sourceTitle, bounds: active.bounds, clientBounds: active.clientBounds },
    matchMode,
  );
  if (!window) {
    onStarted();
    return undefined;
  }
  const accessibleBounds = window.bounds;
  const matchingBounds =
    matchMode === "wayland" &&
    active.clientBounds &&
    accessibleBounds &&
    Math.abs(accessibleBounds.width - active.clientBounds.width) <= 2 &&
    Math.abs(accessibleBounds.height - active.clientBounds.height) <= 2
      ? active.clientBounds
      : active.bounds;
  const locationsReliable =
    active.accessibilityBoundsReliable !== false &&
    (matchMode === "screen-bounds" ||
      (accessibleBounds !== null &&
        Math.abs(accessibleBounds.x - matchingBounds.x) <= 2 &&
        Math.abs(accessibleBounds.y - matchingBounds.y) <= 2));
  const flatRead = window
    .tree()
    .then((tree) => {
      progress.accessibleText =
        accessibleWindowText(tree, SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS) || undefined;
      progress.flatComplete = true;
    })
    .catch(() => {
      progress.flatComplete = true;
    });
  // A decorated screenshot contains more than the accessibility client area. Keep its
  // frame origin/scale so element coordinates include the actual decoration offset.
  const sourceBounds =
    matchMode === "wayland" && active.clientBounds
      ? active.bounds
      : (accessibleBounds ?? active.bounds);
  const richRead = accessibleWindowElementTree(window, sourceBounds, imageSize, {
    locationsReliable,
    onProgress: (root, truncated, descendantLocationsReliable) => {
      progress.richLocationsReliable = descendantLocationsReliable;
      progress.richRoot = root;
      progress.richTruncated = truncated;
    },
    shouldContinue: () => !progress.timedOut,
    verifyDescendantLocations: matchMode === "wayland",
  })
    .then((rich) => {
      progress.richComplete = true;
      if (rich) {
        progress.richRoot = rich.root;
        progress.richTruncated = rich.truncated;
      }
    })
    .catch(() => {
      progress.richComplete = true;
    });
  onStarted();
  await Promise.all([flatRead, richRead]);
  return accessibilityReadSnapshot(progress, imageSize);
}

let activeAccessibilityRead: Promise<unknown> | undefined;

async function raceAccessibleRead<T>(
  run: () => Promise<T>,
  timeoutValue: () => T | undefined,
): Promise<T | undefined> {
  if (activeAccessibilityRead) return undefined;
  const read = run().catch(() => undefined);
  activeAccessibilityRead = read;
  void read.finally(() => {
    if (activeAccessibilityRead === read) activeAccessibilityRead = undefined;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<T | undefined>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue()), ACCESSIBILITY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function readAccessibleWindowContextWithApp(
  App: AccessibilityApp,
  request: SnapShotAccessibilityRequest,
  onStarted: () => void = () => undefined,
): Promise<CapturedWindowAccessibilityContext | undefined> {
  const progress: AccessibilityReadProgress = {
    accessibleText: undefined,
    flatComplete: false,
    richComplete: false,
    richLocationsReliable: false,
    richTruncated: false,
    timedOut: false,
  };
  return raceAccessibleRead(
    () => readCapturedWindowAccessibility(App, request, progress, onStarted),
    () => {
      progress.timedOut = true;
      return accessibilityReadSnapshot(progress, request.imageSize);
    },
  );
}
