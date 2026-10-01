/**
 * Viewport sizing: fill / freeform / preset device modes for the
 * Browser panel, all through `t3.browser/sessions` `resize`. The pure halves
 * of the native panel's behavior live here — the toggle's responsive default,
 * freeform validation, rotation, the preset catalog, the frame geometry the
 * slot's overlay paints, the resize-rail drag math and its commit coalescer,
 * and the serialized commit queue — so each rule is
 * testable without a mounted view. React chrome lives in `viewportToolbar.tsx`.
 *
 * Native sources these mirror (web app, `src/browser/` and
 * `src/components/preview/`): `browserViewportActions.ts` (serialization +
 * 15 s timeout), `browserViewportLayout.ts` (frame layout, rail drag math),
 * `useBrowserViewportResize.ts` (rail gestures), `browserDefaults.ts`
 * (`browserResponsiveViewportForToggle`, `FALLBACK_RESPONSIVE_VIEWPORT_SIZE`),
 * `BrowserDeviceToolbar.tsx` (preset/freeform/rotate semantics), and
 * `@t3tools/shared/previewViewport` (the Chrome DevTools device catalog).
 * The catalog and bounds are vendored rather than imported: bundling
 * `@t3tools/shared/previewViewport` inlines `@t3tools/contracts` source,
 * whose private RPC-name literals fail the shipped-bundle import audit.
 * `viewport.test.mjs` asserts the vendored table equals the live catalog, so
 * drift fails CI instead of shipping.
 */
import type {
  BrowserSessionReceipt,
  BrowserSessionViewport,
} from "@t3tools/extension-sdk/catalogue";

/** A viewport with real dimensions — everything the device toolbar edits. */
export type FixedViewport = Exclude<BrowserSessionViewport, { readonly _tag: "fill" }>;

/** Selectable envelope, vendored from `@t3tools/contracts` `preview.ts`. */
export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;

/** Chrome the host's engine view paints inside a presented slot rect. */
export const DEVICE_TOOLBAR_HEIGHT = 32;
export const DEVICE_VIEWPORT_RAIL = 10;

/** Native `BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS` — per commit, from queue front. */
export const VIEWPORT_COMMIT_TIMEOUT_MS = 15_000;

/** Native `FALLBACK_RESPONSIVE_VIEWPORT_SIZE` — panel not measured yet. */
export const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const;

export interface ViewportPreset {
  readonly id: string;
  readonly label: string;
  /** "375 × 667"-style size line shown in the picker. */
  readonly detail: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The native device catalog (Chrome DevTools' standard devices, in its
 * order), vendored from `@t3tools/shared/previewViewport`. Test-asserted
 * equal to the live table; see the header comment for why it is copied.
 */
export const PREVIEW_VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "iphone-se", label: "iPhone SE", detail: "375 × 667", width: 375, height: 667 },
  { id: "iphone-xr", label: "iPhone XR", detail: "414 × 896", width: 414, height: 896 },
  { id: "iphone-12-pro", label: "iPhone 12 Pro", detail: "390 × 844", width: 390, height: 844 },
  {
    id: "iphone-14-pro-max",
    label: "iPhone 14 Pro Max",
    detail: "430 × 932",
    width: 430,
    height: 932,
  },
  { id: "pixel-7", label: "Pixel 7", detail: "412 × 915", width: 412, height: 915 },
  {
    id: "samsung-galaxy-s8-plus",
    label: "Samsung Galaxy S8+",
    detail: "360 × 740",
    width: 360,
    height: 740,
  },
  {
    id: "samsung-galaxy-s20-ultra",
    label: "Samsung Galaxy S20 Ultra",
    detail: "412 × 915",
    width: 412,
    height: 915,
  },
  { id: "ipad-mini", label: "iPad Mini", detail: "768 × 1024", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", detail: "820 × 1180", width: 820, height: 1180 },
  { id: "ipad-pro", label: "iPad Pro", detail: "1024 × 1366", width: 1024, height: 1366 },
  {
    id: "surface-pro-7",
    label: "Surface Pro 7",
    detail: "912 × 1368",
    width: 912,
    height: 1368,
  },
  { id: "surface-duo", label: "Surface Duo", detail: "540 × 720", width: 540, height: 720 },
  {
    id: "galaxy-z-fold-5",
    label: "Galaxy Z Fold 5",
    detail: "344 × 882",
    width: 344,
    height: 882,
  },
  {
    id: "asus-zenbook-fold",
    label: "Asus Zenbook Fold",
    detail: "853 × 1280",
    width: 853,
    height: 1280,
  },
  {
    id: "samsung-galaxy-a51-71",
    label: "Samsung Galaxy A51/71",
    detail: "412 × 914",
    width: 412,
    height: 914,
  },
  { id: "nest-hub", label: "Nest Hub", detail: "1024 × 600", width: 1024, height: 600 },
  { id: "nest-hub-max", label: "Nest Hub Max", detail: "1280 × 800", width: 1280, height: 800 },
];

/**
 * Identity of a committed setting — the toolbar uses it to drop a stale
 * freeform edit when a resize lands from anywhere else (this view's receipt,
 * the events stream, another client).
 */
export const viewportSettingKey = (setting: BrowserSessionViewport): string =>
  setting._tag === "fill"
    ? "fill"
    : `${setting._tag}:${setting.width}:${setting.height}:${setting._tag === "preset" ? setting.presetId : ""}`;

const clampDimension = (value: number): number =>
  Math.min(PREVIEW_VIEWPORT_MAX_DIMENSION, Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, value));

/**
 * Clamp a size into the selectable envelope: each dimension into
 * 240–3840, then the area under the cap by shrinking the width — the
 * zero-delta branch of the native `resizeFreeformViewport`, which the
 * responsive default and any caller-fed size both go through.
 */
export function clampViewportSize(size: { readonly width: number; readonly height: number }): {
  readonly width: number;
  readonly height: number;
} {
  const width = clampDimension(Math.round(size.width));
  const height = clampDimension(Math.round(size.height));
  if (width * height <= PREVIEW_VIEWPORT_MAX_AREA) return { width, height };
  return {
    width: Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, Math.floor(PREVIEW_VIEWPORT_MAX_AREA / height)),
    height,
  };
}

/**
 * The setting a fill-mode toggle lands on: a freeform "responsive" size
 * fitted to the panel the slot fills. The native panel prefers the user's
 * configured default when it is non-fill; client settings are not a public
 * contract, so the panel-derived size is the honest plugin equivalent.
 */
export function responsiveViewportForToggle(
  panel: { readonly width: number; readonly height: number } | null,
): FixedViewport {
  const size =
    panel === null
      ? FALLBACK_RESPONSIVE_VIEWPORT_SIZE
      : clampViewportSize({
          width: panel.width - DEVICE_VIEWPORT_RAIL * 2,
          height: panel.height - DEVICE_TOOLBAR_HEIGHT - DEVICE_VIEWPORT_RAIL,
        });
  return { _tag: "freeform", ...size };
}

/** Native toolbar `customValid`: an integer size inside the envelope. */
export function validFreeformSize(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
    width <= PREVIEW_VIEWPORT_MAX_DIMENSION &&
    height >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
    height <= PREVIEW_VIEWPORT_MAX_DIMENSION &&
    width * height <= PREVIEW_VIEWPORT_MAX_AREA
  );
}

/** A preset's native-orientation size, or null for an id outside the catalog. */
export function presetViewport(presetId: string): FixedViewport | null {
  const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return null;
  // No orientation requested — the picker offers the preset's own portrait
  // or landscape size, exactly what the native picker commits.
  return { _tag: "preset", width: preset.width, height: preset.height, presetId: preset.id };
}

/**
 * The "Responsive" picker entry: keep the current pixel size, drop the preset
 * tag. The toolbar no-ops when the setting is already freeform, like native.
 */
export function freeformFromSetting(setting: FixedViewport): FixedViewport {
  return { _tag: "freeform", width: setting.width, height: setting.height };
}

/**
 * Rotation swaps the dimensions and keeps everything else — a rotated preset
 * stays a preset with the same id and swapped size, matching native
 * `rotate()`. A valid in-progress freeform edit rotates instead of the
 * committed setting, so an unapplied 900×700 becomes 700×900.
 */
export function rotateViewport(
  setting: FixedViewport,
  pendingSize: { readonly width: number; readonly height: number } | null,
): FixedViewport {
  const source =
    pendingSize !== null &&
    validFreeformSize(pendingSize.width, pendingSize.height) &&
    (pendingSize.width !== setting.width || pendingSize.height !== setting.height)
      ? ({ _tag: "freeform", width: pendingSize.width, height: pendingSize.height } as const)
      : setting;
  return { ...source, width: source.height, height: source.width };
}

// ---------------------------------------------------------------------------
// Commit queue — `sessions.resize`, serialized per session

/**
 * One `resize` dispatch, client-injected so the queue stays testable.
 * `target`, when set, is the tab the change was made against; the port
 * rejects with `ViewportTargetChangedError` if the view holds another tab by
 * the time the commit reaches the front of the queue.
 */
export type ViewportResizePort = (
  viewport: BrowserSessionViewport,
  signal: AbortSignal,
  target: string | undefined,
) => Promise<BrowserSessionReceipt>;

export interface ViewportCommitter {
  /**
   * Queue one resize. Resolutions and rejections both surface to the caller
   * — the UI rolls back by never applying a setting that did not commit, so
   * a rejection carries no compensating dispatch that could overtake a
   * newer resize.
   */
  readonly commit: (
    viewport: BrowserSessionViewport,
    signal: AbortSignal,
    target?: string,
  ) => Promise<BrowserSessionReceipt>;
}

/** A queued resize whose tab is no longer the one the view holds. */
export class ViewportTargetChangedError extends Error {
  override readonly name = "ViewportTargetChangedError";

  constructor() {
    super("The browser session changed before the resize ran");
  }
}

export class ViewportCommitTimeoutError extends Error {
  override readonly name = "ViewportCommitTimeoutError";

  constructor() {
    super("Timed out committing the browser viewport");
  }
}

/**
 * Serializes viewport mutations for one session — the native
 * `browserViewportActions` queue. Commits run strictly in order; the 15 s
 * timeout starts when a commit reaches the front, and a timed-out or failed
 * commit never blocks the queue behind it. Receipts are still applied
 * newest-revision-wins by the view's existing fencing, so the last request
 * to land is the state that sticks.
 */
export function createViewportCommitter(
  resize: ViewportResizePort,
  timeoutMs: number = VIEWPORT_COMMIT_TIMEOUT_MS,
): ViewportCommitter {
  let tail: Promise<void> = Promise.resolve();

  const commit = (viewport: BrowserSessionViewport, signal: AbortSignal, target?: string) => {
    const run = tail.then(() => {
      // The timeout starts when this commit reaches the front of the queue,
      // and the timer is cleared on settle so it can never hold the host.
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new ViewportCommitTimeoutError()), timeoutMs);
      });
      return Promise.race([resize(viewport, signal, target), timeout]).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
    });
    // The tail never rejects, so a failed commit cannot fail its successors.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return { commit };
}

// ---------------------------------------------------------------------------
// Frame geometry — where the engine paints inside the presented slot

export interface ViewportFrameLayout {
  /** Slot-relative box of the device frame the engine composites into. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Presentation-only fit scale (≤ 1); the page's CSS viewport is unchanged. */
  readonly scale: number;
}

/**
 * The box the frame fits into: the slot minus the toolbar strip and the
 * rails — native `resolveBrowserDeviceViewportArea`.
 */
export function deviceViewportArea(slot: { readonly width: number; readonly height: number }): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(1, slot.width - DEVICE_VIEWPORT_RAIL * 2),
    height: Math.max(1, slot.height - DEVICE_TOOLBAR_HEIGHT - DEVICE_VIEWPORT_RAIL),
  };
}

const normalizeZoomFactor = (zoomFactor: number): number =>
  Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;

/**
 * Mirror of the native `resolveBrowserDeviceViewportLayout`. The host's
 * engine view lays out inside whatever rect the slot presents: a toolbar
 * strip, rails, then the viewport frame (CSS size × page zoom) centered and
 * scaled down to fit — never up. The overlay and the rails paint from this
 * same math so plugin chrome and engine pixels coincide.
 */
export function deviceViewportLayout(
  slot: { readonly width: number; readonly height: number },
  setting: { readonly width: number; readonly height: number },
  zoomFactor = 1,
): ViewportFrameLayout {
  const unrounded = deviceViewportArea(slot);
  const area = {
    width: Math.max(1, Math.round(unrounded.width)),
    height: Math.max(1, Math.round(unrounded.height)),
  };
  const zoom = normalizeZoomFactor(zoomFactor);
  const renderedWidth = setting.width * zoom;
  const renderedHeight = setting.height * zoom;
  const scale = Math.min(1, area.width / renderedWidth, area.height / renderedHeight);
  const width = renderedWidth * scale;
  const height = renderedHeight * scale;
  return {
    x: DEVICE_VIEWPORT_RAIL + Math.max(0, Math.round((area.width - width) / 2)),
    y: DEVICE_TOOLBAR_HEIGHT + Math.max(0, Math.round((area.height - height) / 2)),
    width,
    height,
    scale,
  };
}

// ---------------------------------------------------------------------------
// Resize rails — native `BrowserViewportResizeHandles` + `useBrowserViewportResize`

/** The edges native paints a rail on; the toolbar strip owns the top edge. */
export type ViewportRailDirection = "west" | "east" | "south" | "southwest" | "southeast";

/** Native `KEYBOARD_RESIZE_COMMIT_DELAY_MS`: arrow-key edits settle, then commit once. */
export const VIEWPORT_RAIL_KEY_COMMIT_DELAY_MS = 150;

const controlsWidth = (direction: ViewportRailDirection) =>
  direction.includes("east") || direction.includes("west");
const controlsHeight = (direction: ViewportRailDirection) => direction.includes("south");

/** A usable locked ratio: finite and positive, like native `validAspectRatio`. */
const validAspectRatio = (aspectRatio: number | null | undefined): aspectRatio is number =>
  aspectRatio !== null &&
  aspectRatio !== undefined &&
  Number.isFinite(aspectRatio) &&
  aspectRatio > 0;

/**
 * Native `resizeAtAspectRatio`: size the primary axis to `desired` inside
 * the envelope the ratio leaves it, derive the other axis from the ratio,
 * then shrink until the area fits under the cap.
 */
function resizeAtAspectRatio(
  desired: number,
  aspectRatio: number,
  primaryAxis: "width" | "height",
): { readonly width: number; readonly height: number } {
  if (primaryAxis === "width") {
    const minimum = Math.ceil(
      Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, PREVIEW_VIEWPORT_MIN_DIMENSION * aspectRatio),
    );
    const maximum = Math.floor(
      Math.min(
        PREVIEW_VIEWPORT_MAX_DIMENSION,
        PREVIEW_VIEWPORT_MAX_DIMENSION * aspectRatio,
        Math.sqrt(PREVIEW_VIEWPORT_MAX_AREA * aspectRatio),
      ),
    );
    let width = Math.min(maximum, Math.max(minimum, Math.round(desired)));
    let height = Math.round(width / aspectRatio);
    while (width * height > PREVIEW_VIEWPORT_MAX_AREA && width > minimum) {
      width -= 1;
      height = Math.round(width / aspectRatio);
    }
    return { width, height };
  }
  const minimum = Math.ceil(
    Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, PREVIEW_VIEWPORT_MIN_DIMENSION / aspectRatio),
  );
  const maximum = Math.floor(
    Math.min(
      PREVIEW_VIEWPORT_MAX_DIMENSION,
      PREVIEW_VIEWPORT_MAX_DIMENSION / aspectRatio,
      Math.sqrt(PREVIEW_VIEWPORT_MAX_AREA / aspectRatio),
    ),
  );
  let height = Math.min(maximum, Math.max(minimum, Math.round(desired)));
  let width = Math.round(height * aspectRatio);
  while (width * height > PREVIEW_VIEWPORT_MAX_AREA && height > minimum) {
    height -= 1;
    width = Math.round(height * aspectRatio);
  }
  return { width, height };
}

/**
 * The ratio a locked toolbar holds: the committed setting's own shape, so a
 * preset pick or a rotation carries the lock onto the new shape, as native
 * derives it from the viewport rather than storing a number. Null unlocked.
 */
export function lockedAspectRatio(setting: FixedViewport | null, locked: boolean): number | null {
  return locked && setting !== null ? setting.width / setting.height : null;
}

/**
 * Native `resizeFreeformViewport`: apply a CSS-pixel delta along the rail's
 * axes, clamp each dimension into 240–3840, then bring the area under the
 * cap by shrinking the axis that moved most. With an aspect lock the axis
 * that moved (relatively) most leads and the other follows the ratio.
 */
export function resizeViewportBy(
  start: { readonly width: number; readonly height: number },
  delta: { readonly x: number; readonly y: number },
  direction: ViewportRailDirection,
  aspectRatio: number | null = null,
): { readonly width: number; readonly height: number } {
  const horizontal = direction.includes("east")
    ? delta.x
    : direction.includes("west")
      ? -delta.x
      : 0;
  const vertical = direction.includes("south") ? delta.y : 0;
  if (validAspectRatio(aspectRatio)) {
    const desiredWidth = start.width + horizontal;
    const desiredHeight = start.height + vertical;
    const leadsWidth = horizontal !== 0 || direction === "east" || direction === "west";
    const leadsHeight = vertical !== 0 || direction === "south";
    const primaryAxis =
      leadsWidth && !leadsHeight
        ? "width"
        : leadsHeight && !leadsWidth
          ? "height"
          : Math.abs(desiredWidth - start.width) / start.width >=
              Math.abs(desiredHeight - start.height) / start.height
            ? "width"
            : "height";
    return resizeAtAspectRatio(
      primaryAxis === "width" ? desiredWidth : desiredHeight,
      aspectRatio,
      primaryAxis,
    );
  }
  let width = clampDimension(Math.round(start.width + horizontal));
  let height = clampDimension(Math.round(start.height + vertical));
  if (width * height <= PREVIEW_VIEWPORT_MAX_AREA) return { width, height };
  if (Math.abs(horizontal) >= Math.abs(vertical)) {
    width = Math.max(
      PREVIEW_VIEWPORT_MIN_DIMENSION,
      Math.floor(PREVIEW_VIEWPORT_MAX_AREA / height),
    );
  } else {
    height = Math.max(
      PREVIEW_VIEWPORT_MIN_DIMENSION,
      Math.floor(PREVIEW_VIEWPORT_MAX_AREA / width),
    );
  }
  return { width, height };
}

// The frame is centered, so an edge moves half as far as the size changes
// while it fits; past the fit it is scaled and the edge tracks the pointer.
const resizeFromEndRail = (start: number, pointerDelta: number, available: number): number => {
  const startEdge = start < available ? (available + start) / 2 : start;
  const targetEdge = startEdge + pointerDelta;
  return targetEdge <= available ? targetEdge * 2 - available : targetEdge;
};

const resizeFromStartRail = (start: number, pointerDelta: number, available: number): number => {
  if (start > available) {
    const distanceToFit = start - available;
    return pointerDelta <= distanceToFit
      ? start - pointerDelta
      : available - (pointerDelta - distanceToFit) * 2;
  }
  const targetEdge = (available - start) / 2 + pointerDelta;
  return targetEdge >= 0 ? available - targetEdge * 2 : available - targetEdge;
};

/**
 * Native `resizeBrowserViewportFromRail`: the size a drag reaches when the
 * pointer has moved `pointerDelta` screen pixels from where it went down.
 * `available` is the device area and `renderScale` the page zoom times the
 * frame's fit scale, both captured when the drag started, so the grabbed
 * edge stays under the pointer.
 */
export function resizeViewportFromRail(
  start: { readonly width: number; readonly height: number },
  pointerDelta: { readonly x: number; readonly y: number },
  available: { readonly width: number; readonly height: number },
  renderScale: number,
  direction: ViewportRailDirection,
  aspectRatio: number | null = null,
): { readonly width: number; readonly height: number } {
  const scale = normalizeZoomFactor(renderScale);
  const startWidth = start.width * scale;
  const startHeight = start.height * scale;
  const desiredWidth = direction.includes("east")
    ? resizeFromEndRail(startWidth, pointerDelta.x, available.width)
    : direction.includes("west")
      ? resizeFromStartRail(startWidth, pointerDelta.x, available.width)
      : startWidth;
  const desiredHeight = direction.includes("south")
    ? resizeFromEndRail(startHeight, pointerDelta.y, available.height)
    : startHeight;
  const widthDelta = (desiredWidth - startWidth) / scale;
  const heightDelta = (desiredHeight - startHeight) / scale;
  return resizeViewportBy(
    start,
    { x: direction.includes("west") ? -widthDelta : widthDelta, y: heightDelta },
    direction,
    aspectRatio,
  );
}

/**
 * Native arrow-key resize on a focused rail: 10 CSS px, 50 with Shift,
 * only along the axes that rail controls. Null for any other key.
 */
export function railKeyDelta(
  direction: ViewportRailDirection,
  key: string,
  shiftKey: boolean,
): { readonly x: number; readonly y: number } | null {
  const step = shiftKey ? 50 : 10;
  if (key === "ArrowLeft" && controlsWidth(direction)) return { x: -step, y: 0 };
  if (key === "ArrowRight" && controlsWidth(direction)) return { x: step, y: 0 };
  if (key === "ArrowUp" && controlsHeight(direction)) return { x: 0, y: -step };
  if (key === "ArrowDown" && controlsHeight(direction)) return { x: 0, y: step };
  return null;
}

export interface ViewportDragCoalescer {
  /**
   * The size the gesture wants now, for `target` (the tab it edits).
   * Dispatches at once when nothing is in flight; otherwise it replaces any
   * size still waiting, so a drag never has more than one resize in flight
   * and one queued behind it.
   */
  readonly push: (viewport: FixedViewport, target?: string) => void;
  /** Forget the waiting size; an in-flight resize still settles. */
  readonly drop: () => void;
  /** Resolves once nothing is in flight or waiting. */
  readonly whenIdle: () => Promise<void>;
}

/**
 * Coalesces a gesture's resizes onto the serialized commit queue. The
 * dispatch promise must settle (either way) when the commit has been applied
 * or rejected; the next waiting size goes out only then.
 */
export function createViewportDragCoalescer(
  dispatch: (viewport: FixedViewport, target: string | undefined) => Promise<unknown>,
): ViewportDragCoalescer {
  let inFlightKey: string | null = null;
  let waiting: { readonly viewport: FixedViewport; readonly target: string | undefined } | null =
    null;
  let idleWaiters: Array<() => void> = [];
  // The same size on another tab is a different resize.
  const keyOf = (viewport: FixedViewport, target: string | undefined) =>
    `${target ?? ""}|${viewportSettingKey(viewport)}`;

  const send = (viewport: FixedViewport, target: string | undefined) => {
    inFlightKey = keyOf(viewport, target);
    const next = () => {
      inFlightKey = null;
      const queued = waiting;
      waiting = null;
      if (queued) {
        send(queued.viewport, queued.target);
        return;
      }
      const resolvers = idleWaiters;
      idleWaiters = [];
      for (const resolve of resolvers) resolve();
    };
    void Promise.resolve()
      .then(() => dispatch(viewport, target))
      .then(next, next);
  };

  return {
    push: (viewport, target) => {
      if (inFlightKey === null) {
        send(viewport, target);
        return;
      }
      waiting = keyOf(viewport, target) === inFlightKey ? null : { viewport, target };
    },
    drop: () => {
      waiting = null;
    },
    whenIdle: () =>
      inFlightKey === null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
  };
}

export interface RailPreview {
  readonly width: number;
  readonly height: number;
  readonly direction: ViewportRailDirection;
}

/** One gesture (a drag, or a burst of arrow keys) and the settings it produced. */
export interface RailGesture {
  /** The tab the gesture edits; its commits never land on another. */
  readonly target: string;
  /** What a cancelled drag restores. */
  readonly start: FixedViewport;
  /**
   * Settings this gesture expects to see land, oldest first: the committed
   * one it started on, then each size actually dispatched. Receipts land in dispatch
   * order, so a landed key drops everything before it; anything not in the
   * list — including an older size of ours set again elsewhere — is foreign.
   */
  readonly expected: { readonly key: string }[];
  cleanup: (() => void) | null;
  keyTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * The live gesture, its commit coalescer, and the preview it drives. Held
 * once per mounted view, outside render, so effects and handlers share it.
 */
export function createRailGestures(setPreview: (preview: RailPreview | null) => void) {
  // Bound from an effect: the view's latest commit, read at dispatch time.
  let commit: (viewport: FixedViewport, target: string) => Promise<boolean> = () =>
    Promise.resolve(false);
  let gesture: RailGesture | null = null;
  // Record a size as expected only once it is really sent: the coalescer
  // discards most pushed sizes, and a discarded one must not later excuse
  // the same size set elsewhere.
  const coalescer = createViewportDragCoalescer((viewport, target) => {
    const owner = gesture && gesture.target === target ? gesture : null;
    const entry = { key: viewportSettingKey(viewport) };
    owner?.expected.push(entry);
    return commit(viewport, target ?? "").then((applied) => {
      // A rejected resize will never land, so its size is no longer ours.
      if (applied || gesture === null) return;
      const index = gesture.expected.indexOf(entry);
      if (index >= 0) gesture.expected.splice(index, 1);
    });
  });
  // Bumped by every input; a settle only clears the preview it scheduled.
  let version = 0;

  const release = () => {
    if (!gesture) return;
    gesture.cleanup?.();
    gesture.cleanup = null;
    if (gesture.keyTimer !== null) clearTimeout(gesture.keyTimer);
    gesture.keyTimer = null;
  };

  const abort = () => {
    release();
    version += 1;
    coalescer.drop();
    gesture = null;
    setPreview(null);
  };

  return {
    /** `next` resolves true when the server accepted the resize. */
    bindCommit: (next: (viewport: FixedViewport, target: string) => Promise<boolean>) => {
      commit = next;
    },
    /**
     * Start a gesture at `start`, or with `continueLive` extend the live one
     * (a burst of arrow keys). A new gesture inherits the settling one's
     * keys so its still-landing commits are not mistaken for foreign ones.
     */
    begin: (target: string, start: FixedViewport, continueLive: boolean): RailGesture => {
      release();
      version += 1;
      const previous = gesture;
      if (continueLive && previous && previous.target === target) return previous;
      gesture = {
        target,
        start,
        expected:
          previous && previous.target === target
            ? [...previous.expected]
            : [{ key: viewportSettingKey(start) }],
        cleanup: null,
        keyTimer: null,
      };
      return gesture;
    },
    input: (target: RailGesture, next: RailPreview) => {
      if (gesture !== target) return;
      version += 1;
      setPreview(next);
    },
    push: (target: RailGesture, viewport: FixedViewport) => {
      if (gesture !== target) return;
      coalescer.push(viewport, target.target);
    },
    /**
     * Clear the preview once every commit the gesture made has settled —
     * unless newer input arrived meanwhile.
     */
    settle: () => {
      const settling = ++version;
      void coalescer.whenIdle().then(() => {
        if (version !== settling) return;
        gesture = null;
        setPreview(null);
      });
    },
    /**
     * A setting from anywhere else (another client, the events stream, the
     * toolbar) retires the gesture, like native's source-key check.
     */
    observe: (target: string | null, key: string | null) => {
      if (!gesture) return;
      const landed = key === null ? -1 : gesture.expected.findIndex((entry) => entry.key === key);
      if (target !== gesture.target || landed < 0) {
        abort();
        return;
      }
      gesture.expected.splice(0, landed);
    },
    abort,
    dispose: () => {
      release();
      version += 1;
      coalescer.drop();
      gesture = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Failure reporting — the native "Unable to resize browser viewport" toast

/** The `t3.ui/notifications` `notify` seam, structural for testing. */
export interface ViewportFailureNotifier {
  readonly invoke: (
    method: "notify",
    input: {
      readonly severity: "error";
      readonly title: string;
      readonly body?: string;
      readonly threadId: string;
      readonly anchor: "thread";
    },
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export function viewportFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Toast a failed resize when the `t3.ui/notify` grant exists — the native
 * `handleViewportChange` error path. A denied or failing hop rejects, and
 * the caller falls back to the panel's inline fault line.
 */
export async function notifyViewportResizeFailure(
  notifications: ViewportFailureNotifier,
  threadId: string,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  await notifications.invoke(
    "notify",
    {
      severity: "error",
      title: "Unable to resize browser viewport",
      ...(error instanceof Error ? { body: error.message } : {}),
      threadId,
      anchor: "thread",
    },
    signal,
  );
}
