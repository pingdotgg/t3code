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
  readAccessibleWindowContext,
  readAccessibleWindowText,
} from "./DesktopSnapShot.testkit.ts";
import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";

it("does not flash a dismissed overlay after its initial compositor receipt arrives", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ waitForCompositorFrame: true });
  const readingFrame = Promise.withResolvers<void>();
  const frame = Promise.withResolvers<void>();
  transitionCapturePageMock.mockImplementation(() => {
    readingFrame.resolve();
    return frame.promise;
  });

  try {
    const begin = transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      true,
    );
    await readingFrame.promise;
    assert.isFalse(transition.isAnimating);
    transition.dismiss("capture-1");
    assert.isFalse(transition.isAnimating);
    frame.resolve();
    await begin;

    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    frame.resolve();
    transition.dispose();
  }
});

it("does not start a dismissed transition after its compositor receipt arrives", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ waitForCompositorFrame: true });
  const readingFrame = Promise.withResolvers<void>();
  const frame = Promise.withResolvers<void>();
  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionCapturePageMock.mockImplementation(() => {
      readingFrame.resolve();
      return frame.promise;
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
    await readingFrame.promise;
    assert.isTrue(transition.isAnimating);
    transition.dismiss("capture-1");
    assert.isFalse(transition.isAnimating);
    frame.resolve();
    await landing;

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    frame.resolve();
    transition.dispose();
  }
});

it("does not let a failed transition fail landing or capture completion", async () => {
  flashWindows.length = 0;
  transitionScriptState.rejectFlight = true;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transition.animateTo("capture-1", {
      frame: { x: 20, y: 20, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    await transition.waitForLanding("capture-1");
    assert.isFalse(transition.isAnimating);
    await transition.complete("capture-1");

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    transitionScriptState.rejectFlight = false;
    transition.dispose();
  }
});

it.each(["client", "frame"] as const)(
  "maps KDE %s accessibility coordinates into the decorated screenshot",
  async (rootArea) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const clientBounds = { x: 100, y: 229, width: 800, height: 571 };
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          role: "window",
          name: "Editor",
          bounds: rootArea === "client" ? clientBounds : bounds,
          tree: async () => ({ name: "Editor", children: [{ name: "Save", children: [] }] }),
          children: async () => [
            {
              role: "button",
              name: "Save",
              bounds: { x: 120, y: 249, width: 100, height: 50 },
              children: async () => [],
            },
          ],
        },
      ],
    });
    try {
      const context = await readAccessibleWindowContext(
        { title: "Editor", bounds, clientBounds, owner: { processId: 123 } },
        "linux",
        "Editor",
        { width: 1600, height: 1200 },
      );
      assert.equal(context?.accessibility?.format, "element-tree");
      assert.deepEqual(
        context?.accessibility?.format === "element-tree"
          ? context.accessibility.root.children[0]?.bounds
          : undefined,
        { x: 40, y: 98, width: 200, height: 100 },
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each(["darwin", "win32", "linux"] as const)(
  "extracts the same structured accessibility tree on %s",
  async (platform) => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const window = {
      role: "window",
      name: "Editor",
      bounds,
      tree: async () => ({
        name: "Editor",
        children: [
          { name: "Save", children: [] },
          { name: "Below scroll view", children: [] },
        ],
      }),
      children: async () => [
        {
          role: "button",
          name: "Save",
          bounds: { x: 300, y: 350, width: 100, height: 50 },
          children: async () => [],
        },
        {
          role: "static_text",
          name: "Below scroll view",
          bounds: { x: 300, y: 1_000, width: 100, height: 50 },
          visible: false,
          children: async () => [],
        },
      ],
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityForegroundMock
      .mockReset()
      .mockResolvedValue({ pid: 123, asElement: () => window });

    const result = await readAccessibleWindowContext(
      { title: "Editor", bounds, owner: { processId: 123 } },
      platform,
      "Editor",
      { width: 1_600, height: 1_200 },
    );

    assert.equal(result?.accessibility?.format, "element-tree");
    assert.equal(
      result?.accessibility?.format === "element-tree"
        ? result.accessibility.root.children[0]?.name
        : undefined,
      "Save",
    );
    assert.deepInclude(
      result?.accessibility?.format === "element-tree"
        ? result.accessibility.root.children[1]
        : undefined,
      { name: "Below scroll view", bounds: null, state: { visible: false } },
    );
    assert.lengthOf(accessibilityByPidMock.mock.calls, platform === "win32" ? 0 : 1);
    assert.lengthOf(accessibilityForegroundMock.mock.calls, platform === "win32" ? 1 : 0);
  },
);

it.each(["darwin", "win32"] as const)(
  "still requires matching accessibility screen positions on %s",
  async (platform) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
    const window = {
      name: "Editor",
      bounds: { x: 0, y: 0, width: 700, height: 520 },
      tree,
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityForegroundMock
      .mockReset()
      .mockResolvedValue({ pid: 123, asElement: () => window });
    try {
      assert.isUndefined(
        await readAccessibleWindowText(
          {
            title: "Editor",
            bounds: { x: 479, y: 342, width: 700, height: 520 },
            owner: { processId: 123 },
          },
          platform,
          "Editor",
        ),
      );
      assert.lengthOf(tree.mock.calls, 0);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each([
  ["darwin", "", "value", 650],
  ["linux", "wayland", "value", 650],
  ["darwin", "", "name", 100],
] as const)(
  "preserves long text outside the scroll view on %s %s (%s)",
  async (platform, session, field, lines) => {
    const text = `${"Document line\n".repeat(lines)}End of document`;
    vi.stubEnv("XDG_SESSION_TYPE", session);
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    const window = {
      role: "window",
      name: "Editor",
      bounds,
      tree: async () => ({ name: "Editor", children: [{ [field]: text, children: [] }] }),
      children: async () => [
        { role: "text_area", [field]: text, bounds, children: async () => [] },
      ],
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityForegroundMock
      .mockReset()
      .mockResolvedValue({ pid: 123, asElement: () => window });
    try {
      const result = await readAccessibleWindowContext(
        { title: "Editor", bounds, owner: { processId: 123 } },
        platform,
        "Editor",
      );
      assert.deepEqual(result?.accessibility, {
        format: "flat-text",
        text: `Editor\n${text}`,
        truncated: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each([
  { names: ["⠙ t3code"], expected: "Verified text" },
  { names: ["⠋ t3code", "⠙ t3code"], expected: undefined },
])("reads a changing Wayland title only when unambiguous: $names", async ({ names, expected }) => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const tree = vi.fn(async () => ({ value: "Verified text", children: [] }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () =>
      names.map((name) => ({
        name,
        bounds: { x: 0, y: 0, width: 700, height: 520 },
        tree,
      })),
  });
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "⠋ t3code",
          bounds: { x: 479, y: 342, width: 700, height: 520 },
          owner: { processId: 123 },
        },
        "linux",
        "⠋ t3code",
      ),
      expected,
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[123, { timeout: 0 }]]);
    assert.lengthOf(tree.mock.calls, expected ? 1 : 0);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  ["com.google.Chrome", "Google Chrome – Profile"],
  ["org.chromium.Chromium", "Chromium"],
])("reads macOS %s page context with an accessibility title suffix", async (bundleId, suffix) => {
  const title = "Issues · pingdotgg/t3code";
  const bounds = { x: 0, y: 33, width: 1470, height: 857 };
  const window = {
    role: "window",
    name: `${title} - ${suffix}`,
    bounds,
    tree: async () => ({ name: title, children: [{ name: "New issue", children: [] }] }),
    children: async () => [{ role: "button", name: "New issue", bounds, children: async () => [] }],
  };
  accessibilityByPidMock.mockReset().mockImplementation(async (pid: number) => ({
    children: async () => (pid === 42 ? [window] : []),
  }));

  const context = await readAccessibleWindowContext(
    { title, bounds, owner: { processId: 42, bundleId } },
    "darwin",
    title,
  );

  assert.equal(context?.accessibleText, `${title}\nNew issue`);
  assert.equal(context?.accessibility?.format, "element-tree");
  assert.equal(
    context?.accessibility?.format === "element-tree"
      ? context.accessibility.root.children[0]?.name
      : undefined,
    "New issue",
  );
});

