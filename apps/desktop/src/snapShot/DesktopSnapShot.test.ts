import {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessReadMock,
  accessibilityByPidMock,
  accessibilityListMock,
  accessibilityForegroundMock,
  accessibilityTrustedMock,
  allWindowsMock,
  flashWindows,
  focusedWindowMock,
  getSourcesMock,
  macCaptureMock,
  linuxCaptureMock,
  linuxBackendMock,
  niriShortcutMock,
  niriShortcutStopMock,
  mediaAccessStatusMock,
  registerShortcutMock,
  unregisterShortcutMock,
  portalShortcutInstances,
  prepareCaptureRevealMock,
  nextPortalState,
  regionCaptureMock,
  screenToDipRectMock,
  transitionCapturePageMock,
  transitionScriptState,
  transitionSnapshotMock,
} from "./DesktopSnapShot.mocks.ts";


import * as MacPermissions from "../permissions/MacPermissions.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingSnapShot,
  type ClientSettings,
  type DesktopSnapShotEvent,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import type { PortalShortcutState } from "./PortalCaptureShortcut.ts";
import { beforeEach, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "./DesktopSnapShot.ts";
import * as SnapShotAccessibility from "./SnapShotAccessibility.ts";
import { CaptureSetupRequiredError } from "./linuxCaptureSession.ts";
import {
  decodePendingMetadata,
  enabledSettings,
  layerTest,
} from "./DesktopSnapShot.testkit.ts";
import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";

it.effect.each(["darwin", "win32"] as const)(
  "drops shortcut bursts during flight and accepts a fresh capture after landing on %s",
  (platform) => {
    const fixture = concurrentCaptureFixture(platform, true);
    fixture.releaseAll();
    const flying = Promise.withResolvers<void>();
    const heldFlights: Array<() => void> = [];
    const push = heldFlights.push.bind(heldFlights);
    vi.spyOn(heldFlights, "push").mockImplementation((...resolvers) => {
      const count = push(...resolvers);
      flying.resolve();
      return count;
    });
    transitionScriptState.heldFlights = heldFlights;
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        yield* Effect.promise(fixture.trigger);
        const firstId = fixture.readyIds[0]!;
        const landing = yield* service
          .setAnimationDestination(firstId, {
            frame: { x: 100, y: 400, width: 208, height: 112 },
            backgroundColor: "#fff",
            borderColor: "#ccc",
            borderWidth: 1,
            cornerRadius: 8,
            scaleFactor: 1,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => flying.promise);
        const overlayCount = flashWindows.length;

        for (let repeat = 0; repeat < 20; repeat++) {
          yield* TestClock.adjust("200 millis");
          yield* Effect.promise(fixture.trigger);
        }
        assert.equal(fixture.state.snapshots, 1);
        assert.lengthOf(fixture.readyIds, 1);
        assert.lengthOf(flashWindows, overlayCount);
        assert.isTrue(flashWindows.every((window) => !window.destroyed));

        for (const finish of heldFlights) finish();
        yield* Fiber.join(landing);
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        assert.lengthOf(fixture.readyIds, 2);
        assert.isTrue(fixture.second.oldOverlaysCleared);
      }),
    ).pipe(
      Effect.provide(fixture.layer),
      Effect.ensuring(
        Effect.sync(() => {
          for (const finish of heldFlights) finish();
          transitionScriptState.heldFlights = null;
          fixture.reset();
        }),
      ),
    );
  },
);

it.effect.each([
  { length: 1_000, suffix: "", expectedLength: 1_000 },
  { length: 1_001, suffix: "", expectedLength: 1_000 },
  { length: 999, suffix: "😀", expectedLength: 999 },
])(
  "preserves captures with native metadata of length $length and suffix $suffix",
  ({ length, suffix, expectedLength }) => {
    const png = Buffer.from([1, 2, 3]);
    const title = "t".repeat(length) + suffix;
    const appName = "a".repeat(254) + "😀";
    const appIdentifier = "b".repeat(254) + "😀";
    activeWindowMock.mockReset().mockResolvedValue({
      platform: "macos",
      id: 42,
      title,
      owner: { name: appName, bundleId: appIdentifier, processId: 123 },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    focusedWindowMock.mockReturnValue(undefined);
    allWindowsMock.mockReturnValue([]);
    macCaptureMock.mockReset().mockResolvedValue({ source: { name: title }, png });
    accessibilityProcessReadMock.mockReturnValueOnce({
      started: Promise.resolve(),
      result: Promise.resolve(undefined),
    });
    let metadata = "";
    const layer = layerTest("darwin", {
      makeDirectory: () => Effect.void,
      rename: () => Effect.void,
      writeFileString: (_, text) =>
        Effect.sync(() => {
          metadata = text;
        }),
      readDirectory: () => Effect.succeed(["capture.json"]),
      readFileString: () => Effect.succeed(metadata),
      readFile: () => Effect.succeed(png),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        const pending = yield* service.listPending;
        assert.lengthOf(pending, 1);
        const capture = yield* service.read(pending[0]!.id);
        assert.equal(capture.dataUrl, "data:image/png;base64,AQID");
        assert.equal(capture.source.windowTitle, "t".repeat(expectedLength));
        assert.equal(capture.source.appName, "a".repeat(254));
        assert.equal(capture.source.appIdentifier, "b".repeat(254));
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { platform: "win32", animations: true },
  { platform: "darwin", animations: false },
  { platform: "linux", animations: true },
] as const)(
  "captures again while accessibility is pending on $platform (animations: $animations)",
  ({ platform, animations }) => {
    const fixture = concurrentCaptureFixture(platform, animations);
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.started.promise);
        assert.lengthOf(fixture.requestedIds, 1);
        assert.lengthOf(fixture.readyIds, 0);
        fixture.first.pixels.resolve();
        yield* Effect.promise(() => fixture.first.handoff.promise);
        assert.lengthOf(fixture.readyIds, 0);

        yield* TestClock.adjust("200 millis");
        fixture.second.pixels.resolve();
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.handoff.promise);
        assert.equal(fixture.state.snapshots, 2);
        assert.isTrue(fixture.second.oldOverlaysCleared);
        assert.equal(fixture.state.preparations, platform === "win32" ? 2 : 0);
        assert.isTrue(fixture.state.preparedWithoutOverlay);
        if (platform === "linux") assert.isTrue(fixture.second.oldNativeFeedbackClosed);
        const secondOverlays = flashWindows.filter((window) => !window.destroyed);
        if (platform !== "linux") assert.isNotEmpty(secondOverlays);

        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.lengthOf(fixture.readyIds, 1);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, 2);
        assert.equal(new Set(fixture.readyIds).size, 2);
        assert.deepEqual(fixture.readyIds, fixture.requestedIds.toReversed());
        const newer = yield* service.read(fixture.readyIds[0]!);
        const older = yield* service.read(fixture.readyIds[1]!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
        assert.equal(
          newer.dataUrl,
          `data:image/png;base64,${fixture.second.png.toString("base64")}`,
        );
        assert.equal(older.source.windowTitle, fixture.first.title);
        assert.equal(older.source.accessibleText, "Discord accessibility");
        assert.equal(
          older.dataUrl,
          `data:image/png;base64,${fixture.first.png.toString("base64")}`,
        );

        yield* service.acknowledge(fixture.readyIds[1]!);
        assert.isTrue(secondOverlays.every((window) => !window.destroyed));
        if (platform === "linux") {
          assert.lengthOf(fixture.second.feedback.close.mock.calls, 0);
          assert.lengthOf(fixture.second.feedback.complete.mock.calls, 0);
        }
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect.each(["succeeds", "fails"] as const)(
  "keeps the newer snapshot exclusive when older persistence %s",
  (outcome) => {
    const fixture = concurrentCaptureFixture("win32", true);
    fixture.state.failFirstPersistence = outcome === "fails";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        fixture.first.pixels.resolve();
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.handoff.promise);
        yield* TestClock.adjust("200 millis");
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.started.promise);

        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, outcome === "succeeds" ? 1 : 0);
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);

        fixture.second.pixels.resolve();
        yield* Effect.promise(() => fixture.second.handoff.promise);
        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.equal(fixture.state.handoffs, 2);
        const newer = yield* service.read(fixture.readyIds.at(-1)!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect("matches Windows accessibility windows on a scaled display", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  const dipBounds = { x: 5, y: 10, width: 400, height: 300 };
  activeWindowMock.mockReset().mockResolvedValue(active);
  screenToDipRectMock.mockImplementation(() => dipBounds);
  regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
  accessibilityForegroundMock.mockReset().mockResolvedValue({
    pid: 123,
    asElement: () => ({
      role: "window",
      name: "Editor",
      bounds: dipBounds,
      children: async () => [
        {
          role: "button",
          name: "Save",
          bounds: { x: 105, y: 110, width: 100, height: 50 },
          children: async () => [],
        },
      ],
      tree: async () => ({ name: "Editor", value: "Scaled text", children: [] }),
    }),
  });
  let metadata = "";
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;
      const saved = yield* decodePendingMetadata(metadata);
      assert.include(saved.source.accessibleText, "Scaled text");
      assert.deepEqual(
        saved.source.accessibility?.format === "element-tree"
          ? saved.source.accessibility.root.children[0]?.bounds
          : undefined,
        { x: 200, y: 200, width: 200, height: 100 },
      );
    }),
  ).pipe(
    Effect.provide(
      layerTest("win32", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: (_, text) =>
          Effect.sync(() => {
            metadata = text;
          }),
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        screenToDipRectMock.mockImplementation((_window, bounds) => bounds);
      }),
    ),
  );
});

it.effect.each([
  { backend: "gnome", screenshot: "PNG" },
  { backend: "niri", screenshot: "PNG" },
  { backend: "kde", screenshot: "PNG" },
  { backend: "hyprland", screenshot: "PNG" },
  { backend: "gnome", screenshot: "invalid" },
] as const)(
  "persists $backend accessibility text with a $screenshot screenshot",
  ({ backend, screenshot }) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    flashWindows.length = 0;
    const window = {
      title: "Editor",
      appName: "Text Editor",
      appIdentifier: "org.gnome.TextEditor.desktop",
      processId: 123,
      bounds: {
        x: backend === "niri" ? 0 : 479,
        y: backend === "niri" ? 0 : 342,
        width: 700,
        height: backend === "kde" ? 549 : 520,
      },
      ...(backend === "niri" ? { accessibilityBoundsReliable: false } : {}),
      ...(backend === "kde" ? { clientBounds: { x: 479, y: 371, width: 700, height: 520 } } : {}),
    };
    // The captured pixels differ from the compositor's logical window bounds.
    const imageSize = screenshot === "PNG" ? { width: 1400, height: 1040 } : window.bounds;
    const png =
      screenshot === "PNG"
        ? Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAABXgAAAQQAQAAAABwoA4ZAAAAyElEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgYyx4AAepc/c0AAAAASUVORK5CYII=",
            "base64",
          )
        : Buffer.from([1, 2, 3]);
    linuxCaptureMock.mockResolvedValueOnce({ png, window });
    activeWindowMock.mockClear();
    getSourcesMock.mockClear();
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          role: "window",
          name: "Editor",
          bounds: { x: 0, y: 0, width: 700, height: 520 },
          active: true,
          children: async () => [
            {
              role: "button",
              name: "Save",
              bounds: { x: 10, y: 20, width: 80, height: 24 },
              focused: true,
              actions: ["press"],
              children: async () => [],
            },
          ],
          tree: async () => ({ name: "Editor", value: "Verified text", children: [] }),
        },
      ],
    });
    let metadata = "";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        assert.lengthOf(activeWindowMock.mock.calls, 0);
        assert.lengthOf(getSourcesMock.mock.calls, 0);
        assert.deepEqual(accessibilityByPidMock.mock.calls, [[123, { timeout: 0 }]]);
        const saved = yield* decodePendingMetadata(metadata);
        assert.equal(saved.source.appName, "Text Editor");
        assert.equal(saved.source.appIdentifier, window.appIdentifier);
        assert.include(saved.source.accessibleText, "Verified text");
        assert.deepInclude(saved.source.accessibility, {
          format: "element-tree",
          coordinateSpace: "captured-image",
          imageSize: { width: imageSize.width, height: imageSize.height },
          truncated: false,
        });
        assert.deepInclude(
          saved.source.accessibility?.format === "element-tree"
            ? saved.source.accessibility.root
            : undefined,
          {
            role: "window",
            name: "Editor",
            bounds: { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
            state: { active: true },
          },
        );
        assert.isNull(
          saved.source.accessibility?.format === "element-tree"
            ? saved.source.accessibility.root.children[0]?.bounds
            : undefined,
        );
        assert.lengthOf(flashWindows, 0);
      }),
    ).pipe(
      Effect.provide(
        layerTest("linux", {
          makeDirectory: () => Effect.void,
          rename: () => Effect.void,
          writeFile: () => Effect.void,
          writeFileString: (_, text) =>
            Effect.sync(() => {
              metadata = text;
            }),
        }),
      ),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it("covers straddling captures and intervening monitors without spanning unrelated displays", () => {
  const displays = [
    { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
    { bounds: { x: 0, y: 0, width: 1_440, height: 900 } },
    { bounds: { x: 1_440, y: 0, width: 1_280, height: 720 } },
    { bounds: { x: 0, y: -1_080, width: 1_920, height: 1_080 } },
  ];
  const source = { x: -200, y: 100, width: 800, height: 600 };
  assert.deepEqual(
    snapShotAnimationDisplayBounds(displays, source, source),
    displays.slice(0, 2).map((display) => display.bounds),
  );
  assert.deepEqual(
    snapShotAnimationDisplayBounds(
      displays,
      { x: -1_800, y: 100, width: 800, height: 600 },
      { x: 1_600, y: 200, width: 200, height: 112 },
    ),
    displays.slice(0, 3).map((display) => display.bounds),
  );
});

it("cancels a late display while its snapshot is still decoding", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ boundOverlayToCaptureDisplays: true });
  const decoding = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<void>();

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionSnapshotMock.mockImplementationOnce(() => {
      decoding.resolve();
      return decoded.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await decoding.promise;

    transition.dismiss("capture-1");
    decoded.resolve();
    await landing;

    assert.lengthOf(flashWindows, 2);
    assert.strictEqual(flashWindows[1]?.showCount, 0);
    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    decoded.resolve();
    transition.dispose();
  }
});

function concurrentCaptureFixture(platform: NodeJS.Platform, animations: boolean) {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([]);
  registerShortcutMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  animationSettingsMock.mockReturnValue({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  flashWindows.length = 0;
  const captures = ["Discord", "File Explorer", "Terminal"].map((title, index) => ({
    title,
    id: index + 42,
    processId: index + 100,
    png: Buffer.from([index, index + 1, index + 2]),
    started: Promise.withResolvers<void>(),
    pixels: Promise.withResolvers<void>(),
    handoff: Promise.withResolvers<void>(),
    context: Promise.withResolvers<SnapShotAccessibility.CapturedWindowAccessibilityContext>(),
    oldOverlaysCleared: false,
    oldNativeFeedbackClosed: false,
    feedback: {
      animationStarted: animations,
      activate: async () => undefined,
      animateTo: async () => undefined,
      complete: vi.fn<() => Promise<void>>(async () => undefined),
      close: vi.fn(),
    },
  }));
  const [first, second, extra] = captures;
  extra!.pixels.resolve();
  extra!.context.resolve({ accessibleText: extra!.title });
  const state = {
    snapshots: 0,
    handoffs: 0,
    preparations: 0,
    preparedWithoutOverlay: true,
    failFirstPersistence: false,
  };
  const images = new Map<string, Uint8Array>();
  const metadata = new Map<string, string>();
  const readyIds: string[] = [];
  const requestedIds: string[] = [];
  const bounds = { x: 10, y: 20, width: 800, height: 600 };
  const takeSnapshot = async () => {
    const index = state.snapshots++;
    const capture = captures[Math.min(index, captures.length - 1)]!;
    capture.oldOverlaysCleared = flashWindows.every((window) => window.destroyed);
    capture.oldNativeFeedbackClosed = captures
      .slice(0, index)
      .every((previous) => previous.feedback.close.mock.calls.length > 0);
    capture.started.resolve();
    await capture.pixels.promise;
    return capture;
  };
  activeWindowMock.mockReset().mockImplementation(async () => {
    const capture = captures[Math.min(state.snapshots, captures.length - 1)]!;
    return {
      platform: platform === "darwin" ? "macos" : "windows",
      id: capture.id,
      title: capture.title,
      owner: { name: capture.title, processId: capture.processId },
      bounds,
    };
  });
  regionCaptureMock.mockReset().mockImplementation(async () => {
    const capture = await takeSnapshot();
    return { width: bounds.width, height: bounds.height, png: capture.png };
  });
  macCaptureMock.mockReset().mockImplementation(async (_active: unknown, imagePath: string) => {
    const capture = await takeSnapshot();
    images.set(imagePath, capture.png);
    return { source: { name: capture.title }, png: capture.png };
  });
  linuxCaptureMock.mockReset().mockImplementation(async () => {
    const capture = await takeSnapshot();
    return {
      png: capture.png,
      window: {
        title: capture.title,
        appName: capture.title,
        appIdentifier: `test.capture.${capture.id}`,
        processId: capture.processId,
        bounds,
      },
      feedback: capture.feedback,
    };
  });
  const readAccessibility = accessibilityProcessReadMock.getMockImplementation()!;
  accessibilityProcessReadMock.mockImplementation(({ active }) => ({
    started: Promise.resolve(),
    result: captures.find((capture) => capture.processId === active.owner.processId)!.context
      .promise,
  }));
  const handoff = Effect.sync(() => captures[state.handoffs++]!.handoff.resolve());
  let randomByte = 0;
  const layer = Layer.mergeAll(
    layerTest(platform, {
      makeDirectory: () => Effect.void,
      writeFile: (path, bytes) =>
        Effect.sync(() => {
          images.set(path, bytes);
        }),
      writeFileString: (path, text) => {
        const pending = JSON.parse(text) as { source: { windowTitle: string } };
        return state.failFirstPersistence && pending.source.windowTitle === first!.title
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
              }),
            )
          : Effect.sync(() => {
              metadata.set(path, text);
            });
      },
      rename: (from, to) =>
        Effect.sync(() => {
          const image = images.get(from);
          if (image) {
            images.set(to, image);
            images.delete(from);
          }
          const text = metadata.get(from);
          if (text) {
            metadata.set(to, text);
            metadata.delete(from);
          }
        }),
      remove: (path) =>
        Effect.sync(() => {
          images.delete(path);
          metadata.delete(path);
        }),
      readFile: (path) => Effect.sync(() => images.get(path)!),
      readFileString: (path) => Effect.sync(() => metadata.get(path)!),
    }),
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(++randomByte)),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: handoff,
        prepareCaptureReveal: Effect.sync(() => {
          state.preparations++;
          state.preparedWithoutOverlay &&= flashWindows.every((window) => window.destroyed);
        }),
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: (event: DesktopSnapShotEvent) => {
          switch (event.type) {
            case "requested":
              return Effect.sync(() => {
                requestedIds.push(event.id);
              });
            case "started":
              return handoff;
            case "ready":
              return Effect.sync(() => {
                readyIds.push(event.id);
              });
            default:
              return Effect.void;
          }
        },
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
  );
  return {
    first: first!,
    second: second!,
    state,
    readyIds,
    requestedIds,
    layer,
    settings: {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotIncludeAccessibility: true,
      snapShotAnimations: animations,
      snapShotFlash: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
    },
    trigger: () =>
      platform === "linux"
        ? portalShortcutInstances.at(-1)!.onCapture()
        : (registerShortcutMock.mock.calls.at(-1)![1] as () => Promise<void>)(),
    releaseAll: () => {
      for (const capture of captures) {
        capture.pixels.resolve();
        capture.context.resolve({ accessibleText: capture.title });
      }
    },
    reset: () => {
      focusedWindowMock.mockReset();
      linuxCaptureMock.mockReset().mockResolvedValue(undefined);
      accessibilityProcessReadMock.mockReset().mockImplementation(readAccessibility);
      mediaAccessStatusMock.mockReturnValue("not-determined");
      animationSettingsMock.mockReturnValue({
        prefersReducedMotion: true,
        shouldRenderRichAnimation: false,
      });
      vi.unstubAllEnvs();
    },
  };
}
