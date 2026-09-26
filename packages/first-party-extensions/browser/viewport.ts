/**
 * Viewport sizing: fill / freeform / preset device modes for the
 * Browser panel, all through `t3.browser/sessions` `resize`. The pure halves
 * of the native panel's behavior live here — the toggle's responsive default,
 * freeform validation, rotation, the preset catalog, the frame geometry the
 * slot's overlay paints, and the serialized commit queue — so each rule is
 * testable without a mounted view. React chrome lives in `viewportToolbar.tsx`.
 *
 * Native sources these mirror (web app, `src/browser/` and
 * `src/components/preview/`): `browserViewportActions.ts` (serialization +
 * 15 s timeout), `browserViewportLayout.ts` (frame layout), `browserDefaults.ts`
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

/** One `resize` dispatch, client-injected so the queue stays testable. */
export type ViewportResizePort = (
  viewport: BrowserSessionViewport,
  signal: AbortSignal,
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
  ) => Promise<BrowserSessionReceipt>;
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

  const commit = (viewport: BrowserSessionViewport, signal: AbortSignal) => {
    const run = tail.then(() => {
      // The timeout starts when this commit reaches the front of the queue,
      // and the timer is cleared on settle so it can never hold the host.
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new ViewportCommitTimeoutError()), timeoutMs);
      });
      return Promise.race([resize(viewport, signal), timeout]).finally(() => {
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
 * Mirror of the native `resolveBrowserDeviceViewportLayout` (zoom always 1
 * here — zoom commands are out of scope). The host's engine view lays out
 * inside whatever rect the slot presents: a toolbar strip, rails, then the
 * viewport frame centered and scaled down to fit — never up. The overlay
 * paints its visible frame from this same math so plugin chrome and engine
 * pixels coincide.
 */
export function deviceViewportLayout(
  slot: { readonly width: number; readonly height: number },
  setting: FixedViewport,
): ViewportFrameLayout {
  const slotWidth = Math.max(1, Math.round(slot.width));
  const slotHeight = Math.max(1, Math.round(slot.height));
  const areaWidth = Math.max(1, slotWidth - DEVICE_VIEWPORT_RAIL * 2);
  const areaHeight = Math.max(1, slotHeight - DEVICE_TOOLBAR_HEIGHT - DEVICE_VIEWPORT_RAIL);
  const scale = Math.min(1, areaWidth / setting.width, areaHeight / setting.height);
  const width = setting.width * scale;
  const height = setting.height * scale;
  return {
    x: DEVICE_VIEWPORT_RAIL + Math.round((areaWidth - width) / 2),
    y: DEVICE_TOOLBAR_HEIGHT + Math.round((areaHeight - height) / 2),
    width,
    height,
    scale,
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
