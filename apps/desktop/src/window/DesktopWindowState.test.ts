import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { vi } from "vite-plus/test";

// Pin a single 1920x1080 display so the off-screen check is deterministic.
// Inlined because vi.mock factories are hoisted above module-level bindings.
vi.mock("electron", () => ({
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  },
}));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindowState from "./DesktopWindowState.ts";

const PRIMARY_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 } as const;

const DEFAULTS: DesktopWindowState.WindowStateDefaults = {
  defaultBounds: { x: 0, y: 0, width: 1100, height: 780 },
  minWidth: 840,
  minHeight: 620,
};

// 1100x780 centered in a 1920x1080 work area.
const EXPECTED_DEFAULT_BOUNDS = { x: 410, y: 150, width: 1100, height: 780 } as const;

// Permissive on purpose so tests can author version mismatches / partial docs.
const TestRectangle = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const TestWindowStateDocument = Schema.Struct({
  version: Schema.Number,
  normalBounds: TestRectangle,
  restoreMode: Schema.String,
  fullscreenOriginBounds: Schema.optionalKey(TestRectangle),
});
const encodeTestWindowStateDocument = Schema.encodeEffect(
  Schema.fromJsonString(TestWindowStateDocument),
);

function makeEnvironmentLayer(baseDir: string) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "0.0.27",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
}

const withWindowState = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopWindowState.DesktopWindowState | DesktopEnvironment.DesktopEnvironment
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-window-state-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopWindowState.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeRawWindowStateFile(content: string) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(environment.windowStatePath, content);
  });
}

function writeWindowStateDocument(document: typeof TestWindowStateDocument.Type) {
  return Effect.gen(function* () {
    const encoded = yield* encodeTestWindowStateDocument(document);
    yield* writeRawWindowStateFile(`${encoded}\n`);
  });
}

const loadResolved = Effect.gen(function* () {
  const service = yield* DesktopWindowState.DesktopWindowState;
  return yield* service.load(DEFAULTS);
});

describe("DesktopWindowState geometry helpers", () => {
  it("rejects rectangles with non-positive or non-finite dimensions", () => {
    assert.isTrue(DesktopWindowState.hasUsableDimensions({ x: 0, y: 0, width: 10, height: 10 }));
    assert.isFalse(DesktopWindowState.hasUsableDimensions({ x: 0, y: 0, width: 0, height: 10 }));
    assert.isFalse(DesktopWindowState.hasUsableDimensions({ x: 0, y: 0, width: -5, height: 10 }));
    assert.isFalse(
      DesktopWindowState.hasUsableDimensions({ x: Number.NaN, y: 0, width: 10, height: 10 }),
    );
  });

  it("rounds position and clamps dimensions up to the minimums", () => {
    assert.deepEqual(
      DesktopWindowState.sanitizeBounds({ x: 12.4, y: 8.6, width: 200, height: 100 }, 840, 620),
      { x: 12, y: 9, width: 840, height: 620 },
    );
    assert.deepEqual(
      DesktopWindowState.sanitizeBounds({ x: 100, y: 100, width: 1300.2, height: 850.9 }, 840, 620),
      { x: 100, y: 100, width: 1300, height: 851 },
    );
  });

  it("computes intersection area, returning zero for disjoint rectangles", () => {
    assert.equal(
      DesktopWindowState.intersectionArea(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 50, y: 50, width: 100, height: 100 },
      ),
      2_500,
    );
    assert.equal(
      DesktopWindowState.intersectionArea(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 200, y: 200, width: 100, height: 100 },
      ),
      0,
    );
  });

  it("treats a window as visible only when it overlaps a display enough", () => {
    assert.isTrue(
      DesktopWindowState.isWindowVisibleEnough({ x: 100, y: 100, width: 800, height: 600 }, [
        PRIMARY_WORK_AREA,
      ]),
    );
    assert.isFalse(
      DesktopWindowState.isWindowVisibleEnough({ x: 6_000, y: 6_000, width: 800, height: 600 }, [
        PRIMARY_WORK_AREA,
      ]),
    );
  });

  it("centers bounds within a work area", () => {
    assert.deepEqual(
      DesktopWindowState.centerBoundsInWorkArea(PRIMARY_WORK_AREA, 1100, 780),
      EXPECTED_DEFAULT_BOUNDS,
    );
  });
});

describe("DesktopWindowState.load", () => {
  it.effect("returns the centered default when no window-state file exists", () =>
    withWindowState(
      Effect.gen(function* () {
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved, {
          bounds: EXPECTED_DEFAULT_BOUNDS,
          restoreMode: "normal",
        });
      }),
    ),
  );

  it.effect("falls back to the default when the file is malformed", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeRawWindowStateFile("{ this is not json");
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved.bounds, EXPECTED_DEFAULT_BOUNDS);
        assert.equal(resolved.restoreMode, "normal");
      }),
    ),
  );

  it.effect("falls back to the default on a version mismatch", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 2,
          normalBounds: { x: 100, y: 100, width: 1300, height: 850 },
          restoreMode: "normal",
        });
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved.bounds, EXPECTED_DEFAULT_BOUNDS);
      }),
    ),
  );

  it.effect("restores persisted normal bounds", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 1,
          normalBounds: { x: 120, y: 90, width: 1300, height: 850 },
          restoreMode: "normal",
        });
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved, {
          bounds: { x: 120, y: 90, width: 1300, height: 850 },
          restoreMode: "normal",
        });
      }),
    ),
  );

  it.effect("clamps restored bounds up to the minimum window size", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 1,
          normalBounds: { x: 120, y: 90, width: 300, height: 200 },
          restoreMode: "normal",
        });
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved.bounds, { x: 120, y: 90, width: 840, height: 620 });
      }),
    ),
  );

  it.effect("restores the maximized restore mode", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 1,
          normalBounds: { x: 120, y: 90, width: 1300, height: 850 },
          restoreMode: "maximized",
        });
        const resolved = yield* loadResolved;
        assert.equal(resolved.restoreMode, "maximized");
        assert.deepEqual(resolved.bounds, { x: 120, y: 90, width: 1300, height: 850 });
      }),
    ),
  );

  it.effect("restores fullscreen-origin using the saved visible frame", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 1,
          normalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          restoreMode: "fullscreen-origin",
          fullscreenOriginBounds: { x: 60, y: 50, width: 1200, height: 800 },
        });
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved, {
          bounds: { x: 60, y: 50, width: 1200, height: 800 },
          restoreMode: "fullscreen-origin",
        });
      }),
    ),
  );

  it.effect("falls back when fullscreen-origin bounds are missing", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 1,
          normalBounds: { x: 120, y: 90, width: 1300, height: 850 },
          restoreMode: "fullscreen-origin",
        });
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved.bounds, EXPECTED_DEFAULT_BOUNDS);
        assert.equal(resolved.restoreMode, "normal");
      }),
    ),
  );

  it.effect("falls back when persisted bounds are off-screen", () =>
    withWindowState(
      Effect.gen(function* () {
        yield* writeWindowStateDocument({
          version: 1,
          normalBounds: { x: 6_000, y: 6_000, width: 1100, height: 780 },
          restoreMode: "normal",
        });
        const resolved = yield* loadResolved;
        assert.deepEqual(resolved.bounds, EXPECTED_DEFAULT_BOUNDS);
      }),
    ),
  );
});
