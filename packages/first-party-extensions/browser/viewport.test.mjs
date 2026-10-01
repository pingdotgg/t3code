import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import {
  PREVIEW_VIEWPORT_MAX_AREA as CONTRACTS_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION as CONTRACTS_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION as CONTRACTS_MIN_DIMENSION,
  PREVIEW_VIEWPORT_PRESET_IDS,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS as SHARED_PRESETS } from "@t3tools/shared/previewViewport";

// Effect is ESM-only and not a dependency of this package; resolve it from
// the contracts package that owns it (the terminal paneContracts test uses
// the same createRequire reach for its test-time deps).
const contractsRequire = NodeModule.createRequire(
  NodeURL.pathToFileURL(
    NodePath.join(new URL(".", import.meta.url).pathname, "../../contracts/package.json"),
  ),
);
const { Schema } = await import(contractsRequire.resolve("effect"));

import {
  FALLBACK_RESPONSIVE_VIEWPORT_SIZE,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_VIEWPORT_PRESETS,
  VIEWPORT_COMMIT_TIMEOUT_MS,
  clampViewportSize,
  createViewportCommitter,
  createRailGestures,
  createViewportDragCoalescer,
  deviceViewportArea,
  deviceViewportLayout,
  railKeyDelta,
  resizeViewportBy,
  resizeViewportFromRail,
  freeformFromSetting,
  notifyViewportResizeFailure,
  presetViewport,
  responsiveViewportForToggle,
  rotateViewport,
  validFreeformSize,
  viewportFailureMessage,
  viewportSettingKey,
  ViewportCommitTimeoutError,
} from "./viewport.ts";

const receipt = (revision, viewport) => ({
  commandId: "resize",
  outcome: "accepted",
  serverEpoch: "epoch",
  revision,
  session: { tabId: "tab", viewport },
});

// ---------------------------------------------------------------------------
// Preset catalog — the vendored table must be the native table

NodeTest.test("vendored preset table equals the shared/contracts catalog", () => {
  // The table is vendored because bundling @t3tools/shared/previewViewport
  // inlines @t3tools/contracts and fails the bundle import audit; this
  // equality is what keeps the copy honest.
  NodeAssert.deepEqual(
    PREVIEW_VIEWPORT_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      detail: preset.detail,
      width: preset.width,
      height: preset.height,
    })),
    SHARED_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      detail: preset.detail,
      width: preset.width,
      height: preset.height,
    })),
  );
  NodeAssert.deepEqual(
    PREVIEW_VIEWPORT_PRESETS.map((preset) => preset.id),
    [...PREVIEW_VIEWPORT_PRESET_IDS],
  );
  NodeAssert.equal(PREVIEW_VIEWPORT_PRESETS.length, 17);
});

NodeTest.test("vendored bounds equal the contracts constants", () => {
  NodeAssert.equal(PREVIEW_VIEWPORT_MIN_DIMENSION, CONTRACTS_MIN_DIMENSION);
  NodeAssert.equal(PREVIEW_VIEWPORT_MAX_DIMENSION, CONTRACTS_MAX_DIMENSION);
  NodeAssert.equal(PREVIEW_VIEWPORT_MAX_AREA, CONTRACTS_MAX_AREA);
});

// The server's `sessions.resize` decodes its viewport with this schema and
// answers an out-of-bounds request with the named `BrowserSessionInputError`
// ("resize input fails the declared schema or viewport bounds") — proven
// here at the schema the server runs, since no live server is in scope.
const decodeViewport = Schema.decodeUnknownSync(PreviewViewportSetting);

NodeTest.test("the resize schema rejects out-of-bounds viewports by validation", () => {
  NodeAssert.deepEqual(decodeViewport({ _tag: "fill" }), { _tag: "fill" });
  NodeAssert.deepEqual(decodeViewport({ _tag: "freeform", width: 800, height: 600 }), {
    _tag: "freeform",
    width: 800,
    height: 600,
  });
  const rejects = (input) => NodeAssert.throws(() => decodeViewport(input));
  rejects({ _tag: "freeform", width: 100, height: 600 });
  rejects({ _tag: "freeform", width: 600, height: 100 });
  rejects({ _tag: "freeform", width: 3841, height: 600 });
  rejects({ _tag: "freeform", width: 800.5, height: 600 });
  rejects({ _tag: "freeform", width: 3840, height: 3840 });
  rejects({ _tag: "preset", width: 375, height: 667, presetId: "not-a-device" });
  rejects({ _tag: "unexpected" });
});

NodeTest.test("every preset size is inside the selectable envelope", () => {
  for (const preset of PREVIEW_VIEWPORT_PRESETS) {
    NodeAssert.ok(
      validFreeformSize(preset.width, preset.height),
      `${preset.id} (${preset.width}x${preset.height}) must be selectable`,
    );
  }
});

NodeTest.test(
  "presetViewport resolves the preset's native orientation and rejects unknown ids",
  () => {
    NodeAssert.deepEqual(presetViewport("iphone-se"), {
      _tag: "preset",
      width: 375,
      height: 667,
      presetId: "iphone-se",
    });
    // nest-hub is landscape-native; the picker offers its own orientation.
    NodeAssert.deepEqual(presetViewport("nest-hub"), {
      _tag: "preset",
      width: 1024,
      height: 600,
      presetId: "nest-hub",
    });
    NodeAssert.deepEqual(presetViewport("ipad-pro"), {
      _tag: "preset",
      width: 1024,
      height: 1366,
      presetId: "ipad-pro",
    });
    NodeAssert.equal(presetViewport("desktop-1920x1080"), null);
    NodeAssert.equal(presetViewport("no-such-device"), null);
  },
);

// ---------------------------------------------------------------------------
// Toggle semantics — fill → responsive default, non-fill → fill

NodeTest.test("toggle from fill sizes a responsive viewport from the panel", () => {
  // The engine view reserves a toolbar strip and rails inside the slot.
  NodeAssert.deepEqual(responsiveViewportForToggle({ width: 1000, height: 800 }), {
    _tag: "freeform",
    width: 980,
    height: 758,
  });
});

NodeTest.test("toggle from fill with no measurement uses the fallback size", () => {
  NodeAssert.deepEqual(responsiveViewportForToggle(null), {
    _tag: "freeform",
    ...FALLBACK_RESPONSIVE_VIEWPORT_SIZE,
  });
});

NodeTest.test("responsive default clamps oversized panels by area", () => {
  // 4980x3958 device area clamps to 3840x3840, then the area cap shrinks the
  // width — the zero-delta branch of the native freeform resize.
  NodeAssert.deepEqual(responsiveViewportForToggle({ width: 5000, height: 4000 }), {
    _tag: "freeform",
    width: 2160,
    height: 3840,
  });
});

NodeTest.test("clampViewportSize clamps dimensions then area", () => {
  NodeAssert.deepEqual(clampViewportSize({ width: 100, height: 500 }), { width: 240, height: 500 });
  NodeAssert.deepEqual(clampViewportSize({ width: 5000, height: 500 }), {
    width: 3840,
    height: 500,
  });
  // 3840x3840 exceeds the 3840x2160 area cap: width shrinks to fit.
  NodeAssert.deepEqual(clampViewportSize({ width: 4000, height: 4000 }), {
    width: 2160,
    height: 3840,
  });
  NodeAssert.deepEqual(clampViewportSize({ width: 800.4, height: 600.6 }), {
    width: 800,
    height: 601,
  });
});

// ---------------------------------------------------------------------------
// Freeform validation — the width × height inputs

NodeTest.test("validFreeformSize enforces the envelope", () => {
  NodeAssert.ok(validFreeformSize(240, 240));
  NodeAssert.ok(validFreeformSize(3840, 2160));
  NodeAssert.ok(!validFreeformSize(239, 600));
  NodeAssert.ok(!validFreeformSize(600, 239));
  NodeAssert.ok(!validFreeformSize(3841, 600));
  NodeAssert.ok(!validFreeformSize(3840, 3840));
  NodeAssert.ok(!validFreeformSize(800.5, 600));
});

// ---------------------------------------------------------------------------
// Rotation and the Responsive picker entry

NodeTest.test("rotate swaps dimensions and keeps the tag and preset id", () => {
  NodeAssert.deepEqual(rotateViewport({ _tag: "freeform", width: 800, height: 600 }, null), {
    _tag: "freeform",
    width: 600,
    height: 800,
  });
  NodeAssert.deepEqual(
    rotateViewport({ _tag: "preset", width: 375, height: 667, presetId: "iphone-se" }, null),
    { _tag: "preset", width: 667, height: 375, presetId: "iphone-se" },
  );
});

NodeTest.test("rotate prefers a valid pending edit over the committed setting", () => {
  NodeAssert.deepEqual(
    rotateViewport(
      { _tag: "preset", width: 375, height: 667, presetId: "iphone-se" },
      {
        width: 900,
        height: 700,
      },
    ),
    { _tag: "freeform", width: 700, height: 900 },
  );
  // An invalid or unchanged edit rotates the committed setting instead.
  NodeAssert.deepEqual(
    rotateViewport({ _tag: "freeform", width: 800, height: 600 }, { width: 100, height: 100 }),
    { _tag: "freeform", width: 600, height: 800 },
  );
  NodeAssert.deepEqual(
    rotateViewport({ _tag: "freeform", width: 800, height: 600 }, { width: 800, height: 600 }),
    { _tag: "freeform", width: 600, height: 800 },
  );
});

NodeTest.test("freeformFromSetting drops the preset tag, keeps the size", () => {
  NodeAssert.deepEqual(
    freeformFromSetting({ _tag: "preset", width: 430, height: 932, presetId: "iphone-14-pro-max" }),
    {
      _tag: "freeform",
      width: 430,
      height: 932,
    },
  );
});

NodeTest.test("viewportSettingKey distinguishes every setting shape", () => {
  NodeAssert.equal(viewportSettingKey({ _tag: "fill" }), "fill");
  NodeAssert.equal(
    viewportSettingKey({ _tag: "freeform", width: 800, height: 600 }),
    "freeform:800:600:",
  );
  NodeAssert.equal(
    viewportSettingKey({ _tag: "preset", width: 375, height: 667, presetId: "iphone-se" }),
    "preset:375:667:iphone-se",
  );
});

// ---------------------------------------------------------------------------
// Commit queue — serialized per session, newest-wins, rollback on failure

const neverSignal = new AbortController().signal;

NodeTest.test("resizes run serially and newest request wins", async () => {
  const dispatched = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const resize = async (viewport) => {
    dispatched.push(viewport);
    if (dispatched.length === 1) await gate;
    return receipt(dispatched.length, viewport);
  };
  const committer = createViewportCommitter(resize);
  const first = committer.commit({ _tag: "freeform", width: 500, height: 500 }, neverSignal);
  const second = committer.commit({ _tag: "freeform", width: 600, height: 400 }, neverSignal);
  const third = committer.commit({ _tag: "fill" }, neverSignal);
  await new Promise((resolve) => setImmediate(resolve));
  NodeAssert.deepEqual(dispatched, [{ _tag: "freeform", width: 500, height: 500 }]);
  release();
  NodeAssert.deepEqual(await third, receipt(3, { _tag: "fill" }));
  NodeAssert.deepEqual(await second, receipt(2, { _tag: "freeform", width: 600, height: 400 }));
  NodeAssert.deepEqual(await first, receipt(1, { _tag: "freeform", width: 500, height: 500 }));
  NodeAssert.deepEqual(
    dispatched.map((viewport) => viewport._tag),
    ["freeform", "freeform", "fill"],
  );
});

NodeTest.test("a failed commit reports its error and never blocks the queue", async () => {
  const dispatched = [];
  const resize = async (viewport) => {
    dispatched.push(viewport);
    if (viewport._tag === "fill") throw new Error("BrowserSessionInputError: out of bounds");
    return receipt(dispatched.length, viewport);
  };
  const committer = createViewportCommitter(resize);
  // The failure surfaces to its caller — the UI rollback is "never applied".
  await NodeAssert.rejects(committer.commit({ _tag: "fill" }, neverSignal), /out of bounds/);
  const next = await committer.commit({ _tag: "freeform", width: 640, height: 480 }, neverSignal);
  NodeAssert.equal(next.session.viewport.width, 640);
  NodeAssert.equal(dispatched.length, 2);
});

NodeTest.test("a commit that never settles times out from the queue front", async () => {
  const committer = createViewportCommitter(() => new Promise(() => {}), 20);
  await NodeAssert.rejects(committer.commit({ _tag: "fill" }, neverSignal), (error) => {
    NodeAssert.ok(error instanceof ViewportCommitTimeoutError);
    NodeAssert.equal(error.name, "ViewportCommitTimeoutError");
    return true;
  });
  // Default timeout mirrors the native 15 s bound.
  NodeAssert.equal(VIEWPORT_COMMIT_TIMEOUT_MS, 15_000);
  // The queue drains: the next commit still dispatches.
  const resize = async (viewport) => receipt(1, viewport);
  const drained = await createViewportCommitter(resize, 20).commit(
    { _tag: "freeform", width: 300, height: 300 },
    neverSignal,
  );
  NodeAssert.equal(drained.outcome, "accepted");
});

// ---------------------------------------------------------------------------
// Frame geometry — where the engine paints inside the presented slot

NodeTest.test("an exact-fit viewport paints at its size below the chrome", () => {
  const layout = deviceViewportLayout(
    { width: 1000, height: 800 },
    {
      _tag: "freeform",
      width: 800,
      height: 600,
    },
  );
  NodeAssert.equal(layout.scale, 1);
  // Device area 980x758, frame 800x600 centered: x=10+90, y=32+79.
  // Native parity: the rail is already baked into the device area, so y
  // gets only the toolbar height.
  NodeAssert.deepEqual(
    { x: layout.x, y: layout.y, width: layout.width, height: layout.height },
    { x: 100, y: 111, width: 800, height: 600 },
  );
});

NodeTest.test("an oversized viewport scales down to fit and stays centered", () => {
  const layout = deviceViewportLayout(
    { width: 1000, height: 800 },
    {
      _tag: "freeform",
      width: 2000,
      height: 1500,
    },
  );
  // Scale 980/2000 = 0.49 governs; the frame fits the 980x758 device area.
  // Native formula: y = toolbar + round((758 - 735) / 2) = 44.
  NodeAssert.equal(layout.scale, 0.49);
  NodeAssert.equal(layout.width, 980);
  NodeAssert.equal(layout.height, 735);
  NodeAssert.equal(layout.x, 10);
  NodeAssert.equal(layout.y, 44);
});

NodeTest.test("a tiny panel still produces a sane frame", () => {
  const layout = deviceViewportLayout(
    { width: 300, height: 200 },
    {
      _tag: "freeform",
      width: 375,
      height: 667,
    },
  );
  NodeAssert.ok(layout.width >= 1 && layout.height >= 1);
  NodeAssert.ok(layout.scale < 1);
  // Height governs: the frame fills the 158px device area vertically, so
  // native y is exactly the toolbar height (no extra rail).
  NodeAssert.equal(layout.y, 32);
  NodeAssert.equal(layout.x, 106);
});

// Golden values in this section were computed by the native
// `browserViewportLayout.ts` at 227c7dc216. The pack's import audit forbids
// reaching into apps/web from here, so native drift surfaces as a diff in
// these tables when they are regenerated, not as a live comparison.

NodeTest.test("the frame layout follows native under page zoom and fractional slots", () => {
  const golden = [
    [
      { width: 1000, height: 800 },
      { width: 375, height: 667 },
      1.25,
      { x: 287, y: 32, width: 426.16191904047975, height: 758, scale: 0.9091454272863568 },
    ],
    [
      { width: 1000, height: 800 },
      { width: 800, height: 600 },
      2,
      { x: 10, y: 44, width: 980.0000000000001, height: 735, scale: 0.6125 },
    ],
    [
      { width: 413.5, height: 297.25 },
      { width: 375, height: 667 },
      1,
      { x: 135, y: 32, width: 143.36581709145426, height: 255, scale: 0.3823088455772114 },
    ],
  ];
  for (const [slot, size, zoomFactor, expected] of golden) {
    const layout = deviceViewportLayout(slot, size, zoomFactor);
    NodeAssert.deepEqual(
      { x: layout.x, y: layout.y, width: layout.width, height: layout.height, scale: layout.scale },
      expected,
    );
  }
  // The drag's `available` box stays unrounded, like native.
  NodeAssert.deepEqual(deviceViewportArea({ width: 413.5, height: 297.25 }), {
    width: 393.5,
    height: 255.25,
  });
});

// ---------------------------------------------------------------------------
// Resize rails — drag → size math

const RAIL_DIRECTIONS = ["west", "east", "south", "southwest", "southeast"];

NodeTest.test("rail drags reach the native size: fit, scaled, clamped, zoomed", () => {
  // [direction, start, pointer delta, device area, render scale, native size]
  const golden = [
    [
      "east",
      { width: 800, height: 600 },
      { x: 10, y: 0 },
      { width: 980, height: 758 },
      1,
      { width: 820, height: 600 },
    ],
    [
      "east",
      { width: 2000, height: 1500 },
      { x: 49, y: 0 },
      { width: 980, height: 758 },
      0.49,
      { width: 2100, height: 1500 },
    ],
    [
      "west",
      { width: 800, height: 600 },
      { x: -10, y: 0 },
      { width: 980, height: 758 },
      1,
      { width: 820, height: 600 },
    ],
    [
      "west",
      { width: 2000, height: 1500 },
      { x: 30, y: 0 },
      { width: 980, height: 758 },
      0.49,
      { width: 1878, height: 1500 },
    ],
    [
      "west",
      { width: 2000, height: 1500 },
      { x: 600, y: 0 },
      { width: 980, height: 758 },
      0.49,
      { width: 240, height: 1500 },
    ],
    [
      "south",
      { width: 800, height: 600 },
      { x: 10, y: 10 },
      { width: 980, height: 758 },
      1,
      { width: 800, height: 620 },
    ],
    [
      "south",
      { width: 375, height: 667 },
      { x: 0, y: -400 },
      { width: 300, height: 158 },
      0.2368815592203898,
      { width: 375, height: 240 },
    ],
    [
      "southwest",
      { width: 800, height: 600 },
      { x: -10, y: 10 },
      { width: 980, height: 758 },
      1,
      { width: 820, height: 620 },
    ],
    [
      "southeast",
      { width: 800, height: 600 },
      { x: 5000, y: 5000 },
      { width: 980, height: 758 },
      1,
      { width: 2160, height: 3840 },
    ],
    [
      "southeast",
      { width: 3840, height: 2160 },
      { x: -333, y: 90 },
      { width: 980, height: 758 },
      0.3203125,
      { width: 2541, height: 2544 },
    ],
    [
      "east",
      { width: 800, height: 600 },
      { x: 57, y: 0 },
      { width: 980, height: 758 },
      1.25,
      { width: 846, height: 600 },
    ],
    [
      "southwest",
      { width: 240, height: 240 },
      { x: 41, y: -120 },
      { width: 393.5, height: 255.25 },
      2,
      { width: 240, height: 240 },
    ],
  ];
  for (const [direction, start, delta, area, renderScale, expected] of golden) {
    NodeAssert.deepEqual(
      resizeViewportFromRail(start, delta, area, renderScale, direction),
      expected,
      `${direction} ${JSON.stringify({ start, delta, area, renderScale })}`,
    );
  }
});

NodeTest.test("a fitting frame grows twice the pointer travel, a scaled one tracks it", () => {
  // Centered frame: dragging the right edge 10px moves that edge 10px, so the
  // width grows 20px (both edges move apart around the center).
  NodeAssert.deepEqual(
    resizeViewportFromRail(
      { width: 800, height: 600 },
      { x: 10, y: 0 },
      { width: 980, height: 758 },
      1,
      "east",
    ),
    { width: 820, height: 600 },
  );
  // Past the fit the frame is scaled at 0.49; 49 screen px is 100 CSS px.
  NodeAssert.deepEqual(
    resizeViewportFromRail(
      { width: 2000, height: 1500 },
      { x: 49, y: 0 },
      { width: 980, height: 758 },
      0.49,
      "east",
    ),
    { width: 2100, height: 1500 },
  );
  // The left rail mirrors: moving it left grows the width.
  NodeAssert.deepEqual(
    resizeViewportFromRail(
      { width: 800, height: 600 },
      { x: -10, y: 0 },
      { width: 980, height: 758 },
      1,
      "west",
    ),
    { width: 820, height: 600 },
  );
  // Edge rails ignore the off-axis component; corners take both.
  NodeAssert.deepEqual(
    resizeViewportFromRail(
      { width: 800, height: 600 },
      { x: 10, y: 10 },
      { width: 980, height: 758 },
      1,
      "south",
    ),
    { width: 800, height: 620 },
  );
  NodeAssert.deepEqual(
    resizeViewportFromRail(
      { width: 800, height: 600 },
      { x: -10, y: 10 },
      { width: 980, height: 758 },
      1,
      "southwest",
    ),
    { width: 820, height: 620 },
  );
});

NodeTest.test("rail sizes clamp into the vendored envelope", () => {
  // Floor: nothing below 240 on either axis.
  NodeAssert.deepEqual(
    resizeViewportBy({ width: 300, height: 300 }, { x: -1000, y: 1000 }, "east"),
    { width: PREVIEW_VIEWPORT_MIN_DIMENSION, height: 300 },
  );
  // Ceiling: nothing past 3840.
  NodeAssert.deepEqual(
    resizeViewportBy({ width: 1000, height: 1000 }, { x: 0, y: 99_999 }, "south"),
    { width: 1000, height: PREVIEW_VIEWPORT_MAX_DIMENSION },
  );
  // Area cap: the axis that moved most gives way.
  const wide = resizeViewportBy({ width: 3000, height: 2160 }, { x: 900, y: 0 }, "east");
  NodeAssert.deepEqual(wide, { width: 3840, height: 2160 });
  const capped = resizeViewportBy({ width: 3840, height: 2000 }, { x: 0, y: 500 }, "south");
  NodeAssert.equal(capped.width, 3840);
  NodeAssert.equal(capped.height, Math.floor(PREVIEW_VIEWPORT_MAX_AREA / 3840));
  NodeAssert.ok(capped.width * capped.height <= PREVIEW_VIEWPORT_MAX_AREA);
  // Native `resizeFreeformViewport` answers for every rail (unlocked
  // here; viewportAspect.test covers the lock): each dimension clamps, then the area cap.
  const start = { width: 3500, height: 2100 };
  const golden = {
    west: [
      [3840, 2100],
      [2700, 2100],
      [3493, 2100],
    ],
    east: [
      [2500, 2100],
      [3840, 2100],
      [3507, 2100],
    ],
    south: [
      [3500, 2369],
      [3500, 2369],
      [3500, 2097],
    ],
    southwest: [
      [2675, 3100],
      [2700, 3000],
      [3493, 2097],
    ],
    southeast: [
      [2500, 3100],
      [3840, 2160],
      [3507, 2097],
    ],
  };
  const deltas = [
    { x: -1000, y: 1000 },
    { x: 800, y: 900 },
    { x: 7, y: -3 },
  ];
  for (const direction of RAIL_DIRECTIONS) {
    deltas.forEach((delta, index) => {
      const [width, height] = golden[direction][index];
      NodeAssert.deepEqual(resizeViewportBy(start, delta, direction), { width, height });
    });
  }
});

NodeTest.test("arrow keys step 10 (50 with Shift) along the rail's own axes", () => {
  NodeAssert.deepEqual(railKeyDelta("east", "ArrowRight", false), { x: 10, y: 0 });
  NodeAssert.deepEqual(railKeyDelta("west", "ArrowLeft", true), { x: -50, y: 0 });
  NodeAssert.deepEqual(railKeyDelta("south", "ArrowDown", false), { x: 0, y: 10 });
  NodeAssert.deepEqual(railKeyDelta("southeast", "ArrowUp", true), { x: 0, y: -50 });
  NodeAssert.equal(railKeyDelta("south", "ArrowLeft", false), null);
  NodeAssert.equal(railKeyDelta("east", "ArrowUp", false), null);
  NodeAssert.equal(railKeyDelta("east", "Enter", false), null);
  // The west rail grows the width when moved left, like dragging it.
  NodeAssert.deepEqual(
    resizeViewportBy({ width: 800, height: 600 }, railKeyDelta("west", "ArrowLeft", false), "west"),
    { width: 810, height: 600 },
  );
});

// ---------------------------------------------------------------------------
// Resize rails — commit coalescing

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const freeform = (width, height) => ({ _tag: "freeform", width, height });

const flush = () => new Promise((resolve) => setImmediate(resolve));

NodeTest.test("a drag keeps one resize in flight and sends only the latest size next", async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const coalescer = createViewportDragCoalescer((viewport) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const pending = deferred();
    calls.push({ viewport, settle: pending.resolve });
    return pending.promise.finally(() => {
      inFlight -= 1;
    });
  });

  coalescer.push(freeform(500, 400));
  for (let width = 501; width <= 540; width += 1) coalescer.push(freeform(width, 400));
  await flush();
  NodeAssert.deepEqual(
    calls.map((call) => call.viewport),
    [freeform(500, 400)],
  );

  calls[0].settle();
  await flush();
  // The 39 intermediate sizes collapsed into the newest one.
  NodeAssert.deepEqual(
    calls.map((call) => call.viewport),
    [freeform(500, 400), freeform(540, 400)],
  );

  let idle = false;
  void coalescer.whenIdle().then(() => {
    idle = true;
  });
  await flush();
  NodeAssert.equal(idle, false);
  calls[1].settle();
  await flush();
  NodeAssert.equal(idle, true);
  NodeAssert.equal(calls.length, 2);
  NodeAssert.equal(maxInFlight, 1);
});

NodeTest.test("the coalescer skips a waiting size equal to the one in flight", async () => {
  const calls = [];
  const coalescer = createViewportDragCoalescer((viewport) => {
    const pending = deferred();
    calls.push({ viewport, settle: pending.resolve });
    return pending.promise;
  });
  coalescer.push(freeform(600, 400));
  coalescer.push(freeform(610, 400));
  // Dragged back to where the in-flight commit is headed: nothing more to send.
  coalescer.push(freeform(600, 400));
  await flush();
  calls[0].settle();
  await flush();
  NodeAssert.equal(calls.length, 1);
  await coalescer.whenIdle();
});

NodeTest.test(
  "a failed resize does not stall the coalescer, and drop forgets the waiter",
  async () => {
    const calls = [];
    const coalescer = createViewportDragCoalescer((viewport) => {
      const pending = deferred();
      calls.push({ viewport, pending });
      return pending.promise;
    });
    coalescer.push(freeform(700, 500));
    coalescer.push(freeform(720, 500));
    await flush();
    calls[0].pending.reject(new Error("engine gone"));
    await flush();
    NodeAssert.deepEqual(calls[1].viewport, freeform(720, 500));

    coalescer.push(freeform(740, 500));
    coalescer.drop();
    calls[1].pending.resolve();
    await coalescer.whenIdle();
    NodeAssert.equal(calls.length, 2);

    // Idle again: the next push dispatches immediately.
    coalescer.push(freeform(760, 500));
    await flush();
    NodeAssert.deepEqual(calls[2].viewport, freeform(760, 500));
    calls[2].pending.resolve();
    await coalescer.whenIdle();
  },
);

NodeTest.test("the same size for another tab is not a duplicate", async () => {
  const calls = [];
  const coalescer = createViewportDragCoalescer((viewport, target) => {
    const pending = deferred();
    calls.push({ viewport, target, settle: pending.resolve });
    return pending.promise;
  });
  coalescer.push(freeform(820, 600), "tab-a");
  coalescer.push(freeform(820, 600), "tab-b");
  await flush();
  calls[0].settle();
  await flush();
  NodeAssert.deepEqual(
    calls.map((call) => call.target),
    ["tab-a", "tab-b"],
  );
  calls[1].settle();
  await coalescer.whenIdle();
});

NodeTest.test("the committer hands each resize's target tab to the port at dispatch", async () => {
  const seen = [];
  const committer = createViewportCommitter(async (viewport, _signal, target) => {
    seen.push(target);
    return receipt(seen.length, viewport);
  });
  const signal = new AbortController().signal;
  await committer.commit(freeform(500, 400), signal, "tab-a");
  await committer.commit({ _tag: "fill" }, signal);
  NodeAssert.deepEqual(seen, ["tab-a", undefined]);
});

NodeTest.test("a coalesced drag rides the serialized committer in order", async () => {
  const dispatched = [];
  const gates = [];
  const committer = createViewportCommitter((viewport) => {
    dispatched.push(viewport);
    const gate = deferred();
    gates.push(gate);
    return gate.promise.then(() => receipt(dispatched.length, viewport));
  });
  const signal = new AbortController().signal;
  const coalescer = createViewportDragCoalescer((viewport) =>
    committer.commit(viewport, signal).then(
      () => undefined,
      () => undefined,
    ),
  );
  coalescer.push(freeform(400, 300));
  coalescer.push(freeform(420, 300));
  coalescer.push(freeform(440, 300));
  await flush();
  NodeAssert.equal(dispatched.length, 1);
  gates[0].resolve();
  await flush();
  NodeAssert.deepEqual(dispatched, [freeform(400, 300), freeform(440, 300)]);
  gates[1].resolve();
  await coalescer.whenIdle();
  NodeAssert.equal(dispatched.length, 2);
});

// ---------------------------------------------------------------------------
// Resize rails — the gesture state machine behind the hook

const railHarness = () => {
  const previews = [];
  const sent = [];
  const gestures = createRailGestures((preview) => previews.push(preview));
  gestures.bindCommit((viewport, target) => {
    const pending = deferred();
    sent.push({
      viewport,
      target,
      settle: () => pending.resolve(true),
      reject: () => pending.resolve(false),
    });
    return pending.promise;
  });
  return { gestures, previews, sent };
};

const keyOf = (width, height) => viewportSettingKey(freeform(width, height));

NodeTest.test(
  "a drag's own receipts keep it alive; an older size set elsewhere ends it",
  async () => {
    const { gestures, previews, sent } = railHarness();
    const drag = gestures.begin("tab-a", freeform(800, 600), false);
    gestures.push(drag, freeform(820, 600));
    gestures.push(drag, freeform(840, 600));
    await flush();
    gestures.observe("tab-a", keyOf(820, 600));
    sent[0].settle();
    await flush();
    gestures.observe("tab-a", keyOf(840, 600));
    NodeAssert.equal(previews.length, 0);
    // Another client puts 820 back: ours already landed, so this is foreign.
    gestures.observe("tab-a", keyOf(820, 600));
    NodeAssert.deepEqual(previews, [null]);
    gestures.push(drag, freeform(860, 600));
    sent[1].settle();
    await flush();
    NodeAssert.deepEqual(
      sent.map((call) => call.viewport),
      [freeform(820, 600), freeform(840, 600)],
    );
  },
);

NodeTest.test("a coalesced-away size never excuses the same size set elsewhere", async () => {
  const { gestures, previews, sent } = railHarness();
  const drag = gestures.begin("tab-a", freeform(800, 600), false);
  gestures.push(drag, freeform(840, 600));
  // 820 waits, then 840 replaces it: 820 is never sent.
  gestures.push(drag, freeform(820, 600));
  gestures.push(drag, freeform(860, 600));
  await flush();
  sent[0].settle();
  await flush();
  gestures.observe("tab-a", keyOf(840, 600));
  NodeAssert.equal(previews.length, 0);
  gestures.observe("tab-a", keyOf(820, 600));
  NodeAssert.deepEqual(previews, [null]);
  NodeAssert.deepEqual(
    sent.map((call) => call.viewport),
    [freeform(840, 600), freeform(860, 600)],
  );
  sent[1].settle();
});

NodeTest.test("a rejected resize never excuses the same size set elsewhere", async () => {
  const { gestures, previews, sent } = railHarness();
  const drag = gestures.begin("tab-a", freeform(800, 600), false);
  gestures.push(drag, freeform(820, 600));
  await flush();
  sent[0].reject();
  await flush();
  // The drag is still live; another client now sets the size we failed at.
  gestures.observe("tab-a", keyOf(820, 600));
  NodeAssert.deepEqual(previews, [null]);
});

NodeTest.test("switching tabs ends the gesture and drops its waiting size", async () => {
  const { gestures, previews, sent } = railHarness();
  const drag = gestures.begin("tab-a", freeform(800, 600), false);
  gestures.push(drag, freeform(820, 600));
  gestures.push(drag, freeform(840, 600));
  gestures.observe("tab-b", keyOf(800, 600));
  NodeAssert.deepEqual(previews, [null]);
  await flush();
  sent[0].settle();
  await flush();
  NodeAssert.equal(sent.length, 1);
  NodeAssert.equal(sent[0].target, "tab-a");
  // The same size on the new tab still goes out.
  const next = gestures.begin("tab-b", freeform(800, 600), false);
  gestures.push(next, freeform(820, 600));
  await flush();
  NodeAssert.deepEqual(
    sent.map((call) => call.target),
    ["tab-a", "tab-b"],
  );
});

NodeTest.test(
  "a new drag keeps the settling one's queued size and cancels back to it",
  async () => {
    const { gestures, sent } = railHarness();
    const first = gestures.begin("tab-a", freeform(800, 600), false);
    gestures.push(first, freeform(820, 600));
    gestures.push(first, freeform(840, 600));
    gestures.settle();
    // Second drag starts from the 840 on screen before it has landed.
    const second = gestures.begin("tab-a", freeform(840, 600), false);
    NodeAssert.notEqual(second, first);
    await flush();
    sent[0].settle();
    await flush();
    // The first drag's 840 still went out, and its receipt is not foreign.
    NodeAssert.deepEqual(sent[1].viewport, freeform(840, 600));
    gestures.observe("tab-a", keyOf(820, 600));
    gestures.observe("tab-a", keyOf(840, 600));
    gestures.push(second, freeform(860, 600));
    // Cancel: restore the second drag's start (840), not the first's (800).
    // 840 is already in flight, so the queued 860 is simply withdrawn.
    gestures.push(second, second.start);
    sent[1].settle();
    await flush();
    NodeAssert.deepEqual(
      sent.map((call) => call.viewport),
      [freeform(820, 600), freeform(840, 600)],
    );
  },
);

NodeTest.test(
  "the preview clears only when the last commit settles and no input followed",
  async () => {
    const { gestures, previews, sent } = railHarness();
    const drag = gestures.begin("tab-a", freeform(800, 600), false);
    gestures.input(drag, { width: 820, height: 600, direction: "east" });
    gestures.push(drag, freeform(820, 600));
    gestures.settle();
    await flush();
    NodeAssert.equal(previews.at(-1)?.width, 820);
    sent[0].settle();
    await flush();
    NodeAssert.equal(previews.at(-1), null);

    // Input after the settle was scheduled keeps the newer preview.
    const keys = gestures.begin("tab-a", freeform(820, 600), true);
    gestures.push(keys, freeform(830, 600));
    gestures.settle();
    gestures.input(keys, { width: 840, height: 600, direction: "east" });
    await flush();
    sent[1].settle();
    await flush();
    NodeAssert.equal(previews.at(-1)?.width, 840);
  },
);

// ---------------------------------------------------------------------------
// Failure reporting — the toast hop and the message

NodeTest.test("notifyViewportResizeFailure toasts the native title and body", async () => {
  const calls = [];
  await notifyViewportResizeFailure(
    {
      invoke: async (method, input, signal) => {
        calls.push({ method, input, signal });
        return { notificationId: "n1" };
      },
    },
    "thread-1",
    new Error("BrowserStaleServerEpoch: epoch moved"),
    neverSignal,
  );
  NodeAssert.equal(calls.length, 1);
  NodeAssert.equal(calls[0].method, "notify");
  NodeAssert.deepEqual(calls[0].input, {
    severity: "error",
    title: "Unable to resize browser viewport",
    body: "BrowserStaleServerEpoch: epoch moved",
    threadId: "thread-1",
    anchor: "thread",
  });
});

NodeTest.test(
  "notifyViewportResizeFailure surfaces non-Error failures as a toast without a body",
  async () => {
    const calls = [];
    await notifyViewportResizeFailure(
      {
        invoke: async (_method, input) => {
          calls.push(input);
          return { notificationId: "n2" };
        },
      },
      "thread-1",
      "boom",
      neverSignal,
    );
    NodeAssert.deepEqual(calls, [
      {
        severity: "error",
        title: "Unable to resize browser viewport",
        threadId: "thread-1",
        anchor: "thread",
      },
    ]);
    NodeAssert.equal(viewportFailureMessage(new Error("x")), "x");
    NodeAssert.equal(viewportFailureMessage("x"), "An error occurred.");
  },
);

NodeTest.test("a denied notify hop rejects so the caller falls back inline", async () => {
  await NodeAssert.rejects(
    notifyViewportResizeFailure(
      {
        invoke: async () => {
          throw new Error("grant denied");
        },
      },
      "thread-1",
      new Error("resize failed"),
      neverSignal,
    ),
    /grant denied/,
  );
});
