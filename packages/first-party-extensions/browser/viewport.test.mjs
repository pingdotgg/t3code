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
  deviceViewportLayout,
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
