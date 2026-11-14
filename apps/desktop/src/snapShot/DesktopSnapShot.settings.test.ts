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
  enabledSettings,
  layerTest,
  readAccessibleWindowContext,
  readAccessibleWindowText,
} from "./DesktopSnapShot.testkit.ts";
import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";

it("does not borrow another Chrome process context when the captured PID has no windows", async () => {
  const title = "Issues · pingdotgg/t3code";
  const bounds = { x: 0, y: 33, width: 1470, height: 857 };
  const otherWindow = {
    role: "window",
    name: `${title} - Google Chrome – Profile`,
    bounds,
    tree: async () => ({
      name: title,
      children: [{ name: "Other process private text", children: [] }],
    }),
    children: async () => [],
  };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    pid: 42,
    children: async () => [],
  });
  accessibilityListMock.mockResolvedValue([
    { pid: 43, bundleId: "com.google.Chrome", children: async () => [otherWindow] },
  ]);

  assert.isUndefined(
    await readAccessibleWindowContext(
      { title, bounds, owner: { processId: 42, bundleId: "com.google.Chrome" } },
      "darwin",
      title,
    ),
  );
});

it("reads Flatpak app text from the AT-SPI proxy when the compositor PID misses", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({
    name: "Issue — Zen Browser",
    children: [{ name: "New Tab", children: [] }],
  }));
  const proxyWindow = {
    role: "window",
    name: "Issue — Zen Browser",
    bounds,
    tree,
    children: async () => [],
  };
  accessibilityByPidMock
    .mockReset()
    .mockRejectedValue(
      new Error("XA11Y_SELECTOR_NOT_MATCHED: No element matched selector: application[pid=207651]"),
    );
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      pid: 1,
      children: async () => [
        {
          role: "window",
          name: "Files",
          bounds,
          tree: async () => ({ name: "Files", children: [] }),
        },
      ],
    },
    { pid: 207646, children: async () => [proxyWindow] },
  ]);
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "Issue — Zen Browser",
          bounds: { x: 0, y: 0, width: 1_920, height: 1_048 },
          owner: { processId: 207651 },
        },
        "linux",
        "Issue — Zen Browser",
      ),
      "Issue — Zen Browser\nNew Tab",
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[207651, { timeout: 0 }]]);
    assert.lengthOf(accessibilityListMock.mock.calls, 1);
    assert.lengthOf(tree.mock.calls, 1);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
    vi.unstubAllEnvs();
  }
});

it("reads GTK4 app text from one unnamed PID-scoped window of the captured size", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({
    name: "System Monitor",
    children: [{ name: "CPU", children: [] }],
  }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "group",
        name: null,
        bounds,
        tree,
        children: async () => [
          { role: "page_tab_list", name: "Processes", bounds, children: async () => [] },
        ],
      },
    ],
  });
  accessibilityListMock.mockReset().mockResolvedValue([]);
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "System Monitor",
          bounds: { x: 12, y: 48, width: 1_920, height: 1_048 },
          owner: { processId: 210600 },
        },
        "linux",
        "System Monitor",
      ),
      "System Monitor\nCPU",
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[210600, { timeout: 0 }]]);
    assert.lengthOf(accessibilityListMock.mock.calls, 0);
    assert.lengthOf(tree.mock.calls, 1);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
    vi.unstubAllEnvs();
  }
});

it("does not guess GTK4 app text when two unnamed PID windows share the captured size", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      { role: "group", name: null, bounds, tree },
      { role: "group", name: null, bounds: { ...bounds, x: 12 }, tree },
    ],
  });
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      pid: 99,
      children: async () => [{ role: "window", name: "System Monitor", bounds, tree }],
    },
  ]);
  try {
    assert.isUndefined(
      await readAccessibleWindowText(
        {
          title: "System Monitor",
          bounds: { x: 12, y: 48, width: 1_920, height: 1_048 },
          owner: { processId: 210600 },
        },
        "linux",
        "System Monitor",
      ),
    );
    assert.lengthOf(accessibilityListMock.mock.calls, 0);
    assert.lengthOf(tree.mock.calls, 0);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
    vi.unstubAllEnvs();
  }
});

it("keeps a truncated element tree when the flat text read fails", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds,
        tree: async () => {
          throw new Error("Text read failed");
        },
        children: async () => [
          {
            role: "text_area",
            value: "x".repeat(8_001),
            bounds: { x: 10, y: 50, width: 700, height: 500 },
            children: async () => [],
          },
        ],
      },
    ],
  });

  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "darwin",
    "Editor",
  );
  assert.equal(result?.accessibility?.format, "element-tree");
  assert.isTrue(result?.accessibility?.truncated);
  assert.deepEqual(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.bounds
      : undefined,
    { x: 10, y: 50, width: 700, height: 500 },
  );
});

it.effect("flags revoked macOS permissions on read and re-registers once they return", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  registerShortcutMock.mockReset().mockReturnValue(true);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true });
      assert.isNull((yield* service.state).message);

      mediaAccessStatusMock.mockReturnValue("denied");
      const revoked = yield* service.state;
      assert.equal(
        revoked.message,
        "Allow Screen Recording in System Settings, then restart T3 Code.",
      );
      assert.deepEqual(revoked.macPermissions, { screenRecording: false, accessibility: true });

      accessibilityTrustedMock.mockReturnValue(false);
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
      });
      const blocked = yield* service.state;
      assert.equal(
        blocked.message,
        "Allow Screen Recording in System Settings, then restart T3 Code.",
      );
      assert.isFalse(blocked.shortcutRegistered);

      mediaAccessStatusMock.mockReturnValue("granted");
      const recovered = yield* service.state;
      assert.isNull(recovered.message);
      assert.isTrue(recovered.shortcutRegistered);
    }),
  ).pipe(Effect.provide(layerTest("darwin")));
});

it.effect("an unrelated client-setting change keeps the registered shortcut", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  unregisterShortcutMock.mockReset();
  const settings = enabledSettings({
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K"],
      );

      yield* service.configure({ ...settings, wordWrap: !settings.wordWrap });
      assert.lengthOf(unregisterShortcutMock.mock.calls, 0);
      assert.lengthOf(registerShortcutMock.mock.calls, 1);
      assert.isTrue((yield* service.state).shortcutRegistered);

      yield* service.configure({
        ...settings,
        snapShotShortcut: { ...settings.snapShotShortcut, key: "j" },
      });
      assert.deepEqual(unregisterShortcutMock.mock.calls, [["Control+Alt+K"]]);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K", "Control+Alt+J"],
      );
    }),
  ).pipe(Effect.provide(layerTest("win32")));
});

it.effect("capture fails closed while snapshots are disabled", () => {
  activeWindowMock.mockClear();
  getSourcesMock.mockClear();
  regionCaptureMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: false });
      const failure = yield* Effect.flip(service.capture);
      assert.equal(failure.operation, "disabled");
      assert.lengthOf(activeWindowMock.mock.calls, 0);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(regionCaptureMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layerTest("win32")));
});

it.effect("points capture setup failures at SnapShot settings", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  linuxCaptureMock.mockRejectedValueOnce(new CaptureSetupRequiredError("Install the helper."));
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      const failure = yield* Effect.flip(service.capture);
      assert.equal(failure.operation, "setup-required");
    }),
  ).pipe(
    Effect.provide(layerTest("linux", { makeDirectory: () => Effect.void })),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect(
  "keeps saved preferences but rechecks access and shortcut delivery after changing desktops",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    vi.stubEnv("NIRI_SOCKET", "/test/niri.sock");
    vi.stubEnv("FLATPAK_ID", "");
    vi.stubEnv("SNAP", "");
    registerShortcutMock.mockReset().mockReturnValue(true);
    niriShortcutMock.mockReset().mockResolvedValue(niriShortcutStopMock);
    const settings: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
      snapShotPlaySound: false,
      snapShotAnimations: false,
    };
    return Effect.gen(function* () {
      for (const [desktop, backend] of [
        ["GNOME", "gnome-extension"],
        ["niri", "niri"],
        ["KDE", "kde"],
        ["Hyprland", "hyprland"],
        ["GNOME", "gnome-extension"],
      ] as const) {
        vi.stubEnv("XDG_CURRENT_DESKTOP", desktop);
        linuxBackendMock.mockResolvedValue(backend);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* DesktopSnapShot.make;
            yield* service.initialize;
            const state = yield* service.state;
            assert.equal(state.linuxDesktop, desktop.toLowerCase());
            assert.equal(state.linuxBackend, backend);
            assert.deepEqual(state.shortcut, settings.snapShotShortcut);
            assert.isFalse(state.shortcutVerified);
            assert.equal(state.gnomeExtension?.status, desktop === "GNOME" ? "enabled" : undefined);
            assert.equal(state.kdeHelper?.status, desktop === "KDE" ? "not-installed" : undefined);
            assert.equal(
              state.hyprlandHelper?.status,
              desktop === "Hyprland" ? "not-installed" : undefined,
            );
            assert.equal(
              Boolean(state.shortcutBinding),
              desktop === "niri" || desktop === "Hyprland",
            );
            const trigger =
              desktop === "niri"
                ? niriShortcutMock.mock.calls.at(-1)![1]
                : portalShortcutInstances.at(-1)!.onCapture;
            yield* Effect.promise(async () => {
              await trigger();
            });
            assert.isTrue((yield* service.state).shortcutVerified);
          }),
        ).pipe(Effect.provide(layerTest("linux", {}, Option.some(settings))));
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          linuxBackendMock.mockResolvedValue("picker");
          vi.unstubAllEnvs();
        }),
      ),
    );
  },
);

it.effect("verifies only native shortcut delivery and captures normally", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  vi.stubEnv("XDG_CURRENT_DESKTOP", "test-desktop");
  registerShortcutMock.mockReset().mockReturnValue(true);
  linuxCaptureMock.mockClear().mockResolvedValue({
    png: Buffer.from([1, 2, 3]),
    window: {
      title: "Shortcut capture",
      appName: "Text Editor",
      appIdentifier: "org.kde.kwrite",
      processId: 123,
      bounds: { x: 0, y: 0, width: 700, height: 520 },
    },
  });
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotIncludeAccessibility: false,
    snapShotShortcut: {
      key: "2",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      modKey: false,
    },
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.isFalse((yield* service.state).shortcutVerified);
      yield* service.capture;
      assert.isFalse((yield* service.state).shortcutVerified);
      linuxCaptureMock.mockClear();
      const trigger = portalShortcutInstances.at(-1)!.onCapture;
      yield* service.setShortcutSuppressed(true);
      yield* Effect.promise(trigger);
      assert.isFalse((yield* service.state).shortcutVerified);
      assert.lengthOf(linuxCaptureMock.mock.calls, 0);
      yield* service.setShortcutSuppressed(false);
      yield* Effect.promise(trigger);
      assert.isTrue((yield* service.state).shortcutVerified);
      assert.lengthOf(linuxCaptureMock.mock.calls, 1);
      yield* service.setup("retry-shortcut");
      assert.equal(portalShortcutInstances.length, 1);
      assert.equal(portalShortcutInstances[0]!.configure.mock.calls.length, 1);
      yield* service.configure({ ...settings, snapShotEnabled: false });
      assert.isFalse((yield* service.state).shortcutVerified);
    }),
  ).pipe(
    Effect.provide(
      layerTest("linux", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: () => Effect.void,
      }),
    ),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect(
  "preserves an approved portal session for cosmetic changes and retires it when keys change",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(settings);
        const first = portalShortcutInstances[0]!;
        yield* Effect.promise(first.onCapture);
        yield* service.configure({
          ...settings,
          snapShotPlaySound: false,
          snapShotFlash: false,
        });
        assert.equal(portalShortcutInstances.length, 1);
        assert.equal(first.close.mock.calls.length, 0);
        assert.isTrue((yield* service.state).shortcutVerified);
        yield* service.configure({
          ...settings,
          snapShotShortcut: { ...settings.snapShotShortcut, key: "8" },
        });
        assert.equal(first.close.mock.calls.length, 1);
        assert.equal(portalShortcutInstances.length, 2);
        assert.isFalse((yield* service.state).shortcutVerified);
        yield* Effect.promise(first.onCapture);
        assert.isFalse((yield* service.state).shortcutVerified);
        const current = portalShortcutInstances[1]!;
        yield* Effect.promise(current.onCapture);
        assert.isTrue((yield* service.state).shortcutVerified);
        yield* service.configure({ ...settings, snapShotEnabled: false });
        assert.equal(current.close.mock.calls.length, 1);
        yield* Effect.promise(current.onCapture);
        assert.isFalse((yield* service.state).shortcutVerified);
        assert.isFalse((yield* service.state).shortcutRegistered);
      }),
    ).pipe(
      Effect.provide(layerTest("linux")),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it.effect(
  "keeps Hyprland's stable action with a modifier-pair preference and releases it when disabled",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    vi.stubEnv("XDG_CURRENT_DESKTOP", "Hyprland");
    vi.stubEnv("FLATPAK_ID", "");
    vi.stubEnv("SNAP", "");
    nextPortalState.value = {
      shortcutRegistered: false,
      shortcutActionRegistered: true,
      shortcutPending: false,
      shortcutMessage: "Managed by Hyprland",
    };
    const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(settings);
        assert.lengthOf(portalShortcutInstances, 1);
        const first = portalShortcutInstances[0]!;
        assert.isTrue((yield* service.state).shortcutActionRegistered);
        const check = yield* service.checkShortcut(settings.snapShotShortcut);
        assert.isFalse(check.available);
        assert.include(check.message, "Hyprland config");
        yield* service.configure({ ...settings, snapShotPlaySound: false });
        assert.lengthOf(portalShortcutInstances, 1);
        assert.lengthOf(first.close.mock.calls, 0);
        yield* service.configure({ ...settings, snapShotEnabled: false });
        assert.lengthOf(first.close.mock.calls, 1);
        assert.notEqual((yield* service.state).shortcutActionRegistered, true);
      }),
    ).pipe(
      Effect.provide(layerTest("linux")),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it.effect("waits to apply settings while permissions are pending", () => {
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValueOnce("not-determined").mockReturnValue("granted");
  let finishPermissionRequest: (() => void) | undefined;
  getSourcesMock.mockImplementationOnce(
    () =>
      new Promise<Array<never>>((resolve) => {
        finishPermissionRequest = () => resolve([]);
      }),
  );
  const layer = layerTest("darwin");

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const enabled = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
      const permissionFiber = yield* service.requestPermissions(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      if (!finishPermissionRequest) throw new Error("Permission request did not start");
      const finishPermission = finishPermissionRequest;

      const configureFiber = yield* service.configure(enabled).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isFalse((yield* service.state).shortcutRegistered);
      finishPermission();
      yield* Fiber.join(permissionFiber);
      yield* Fiber.join(configureFiber);

      const state = yield* service.state;
      assert.isTrue(state.shortcutRegistered);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "tests macOS capture without publishing it and cleans up, failure=%s",
  (fails) => {
    const active = {
      platform: "macos",
      id: 42,
      title: "Setup",
      owner: { name: "T3 Code", processId: 123, path: "/Applications/T3 Code.app" },
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    activeWindowMock.mockReset().mockResolvedValue(active);
    macCaptureMock.mockReset();
    if (fails) macCaptureMock.mockRejectedValue(new Error("Capture denied"));
    else macCaptureMock.mockResolvedValue({ source: { name: "Setup" }, png: Buffer.from("png") });
    accessibilityProcessReadMock.mockClear();
    const cleanup = vi.fn();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        if (fails) {
          const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
          assert.equal(error.reason, "setup-failed");
          assert.equal(
            error.message,
            'Could not capture a test snapshot. Capturing the window failed. macOS grants Screen Recording and Accessibility to each app separately. In System Settings, open Privacy & Security and check that "T3 Code (Dev)" is allowed for both.',
          );
        } else yield* service.setup("test-mac-capture");
        assert.equal(macCaptureMock.mock.calls.length, 1);
        assert.equal(macCaptureMock.mock.calls[0]?.[0], active);
        assert.equal(macCaptureMock.mock.calls[0]?.[1], "/tmp/setup-test/test.png");
        assert.equal(cleanup.mock.calls.length, 1);
        assert.equal(accessibilityProcessReadMock.mock.calls.length, 0);
        assert.deepEqual(yield* service.listPending, []);
      }),
    ).pipe(
      Effect.provide(
        layerTest("darwin", {
          makeTempDirectoryScoped: () =>
            Effect.acquireRelease(Effect.succeed("/tmp/setup-test"), () =>
              Effect.sync(() => {
                cleanup();
              }),
            ),
          readDirectory: () => Effect.succeed([]),
        }),
      ),
    );
  },
);

