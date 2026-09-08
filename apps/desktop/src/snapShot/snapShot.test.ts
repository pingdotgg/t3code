import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  accessibleWindowElementTree,
  accessibleWindowText,
  capturedImageBounds,
  compactAccessibilityTree,
  findAccessibleWindow,
  findCaptureSource,
  hideAndWaitForBlur,
  isWaylandSession,
  snapShotShortcutRegistrationFailureMessage,
  snapShotShortcutSystemConflict,
  toElectronAccelerator,
} from "./snapShot.ts";
import { DesktopSnapShotError } from "./DesktopSnapShot.ts";

describe("window capture errors", () => {
  it.each([
    ["unsupported", "SnapShots are not supported here."],
    ["disabled", "Enable SnapShots in Settings first."],
    ["no-window-selected", "No window was selected."],
    ["window-unavailable", "The active window is not available for capture."],
    ["capture", "Could not capture the active window."],
  ] as const)("keeps %s failures user-facing", (operation, message) => {
    expect(new DesktopSnapShotError({ operation }).message).toBe(message);
  });
});

describe("accessibleWindowText", () => {
  it("keeps unique names and values in tree order", () => {
    expect(
      accessibleWindowText(
        {
          name: "Settings",
          children: [
            {
              name: "General",
              children: [],
            },
            {
              name: "Name",
              value: "Bilal",
              children: [],
            },
          ],
        },
        100,
      ),
    ).toBe("Settings\nGeneral\nName\nBilal");
  });

  it("caps large text without splitting a surrogate pair", () => {
    expect(
      accessibleWindowText(
        {
          value: "abc😀def",
          children: [],
        },
        5,
      ),
    ).toBe("abc😀");
  });

  it("stops traversing very large trees", () => {
    expect(
      accessibleWindowText(
        {
          children: [
            ...Array.from({ length: 10_000 }, () => ({ children: [] })),
            { value: "past node limit", children: [] },
          ],
        },
        100,
      ),
    ).not.toContain("past node limit");
  });
});

describe("accessibleWindowElementTree", () => {
  it("maps element bounds into captured-image pixels and keeps semantic state", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        name: "Editor",
        bounds: { x: 100, y: 200, width: 800, height: 600 },
        active: true,
        children: async () => [
          {
            role: "button",
            name: "Save",
            description: "Save the document",
            bounds: { x: 300, y: 350, width: 100, height: 50 },
            focused: true,
            actions: ["press", "press"],
            children: async () => [],
          },
        ],
      },
      { x: 100, y: 200, width: 800, height: 600 },
      { width: 1_600, height: 1_200 },
    );

    expect(tree).toEqual({
      truncated: false,
      root: {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 1_600, height: 1_200 },
        state: { active: true },
        children: [
          {
            role: "button",
            name: "Save",
            description: "Save the document",
            bounds: { x: 400, y: 300, width: 200, height: 100 },
            state: { focused: true },
            actions: ["press"],
            children: [],
          },
        ],
      },
    });
  });

  it("uses null child bounds when a Wayland provider reports only the root origin", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: async () => [
          {
            role: "button",
            name: "Save",
            bounds: { x: 0, y: 0, width: 100, height: 50 },
            children: async () => [],
          },
        ],
      },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 1_600, height: 1_200 },
      { locationsReliable: true, verifyDescendantLocations: true },
    );

    expect(tree?.root.bounds).toEqual({ x: 0, y: 0, width: 1_600, height: 1_200 });
    expect(tree?.root.children[0]?.bounds).toBeNull();
  });

  it("keeps Wayland child bounds after observing real position variation", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: async () => [
          {
            role: "button",
            name: "Save",
            bounds: { x: 20, y: 30, width: 100, height: 50 },
            children: async () => [],
          },
        ],
      },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 1_600, height: 1_200 },
      { locationsReliable: true, verifyDescendantLocations: true },
    );

    expect(tree?.root.children[0]?.bounds).toEqual({ x: 40, y: 60, width: 200, height: 100 });
  });

  it("does not mistake a title-bar offset for varying descendant positions", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        bounds: { x: 100, y: 229, width: 800, height: 571 },
        children: async () => [
          {
            role: "button",
            name: "Save",
            bounds: { x: 100, y: 229, width: 100, height: 50 },
            children: async () => [],
          },
        ],
      },
      { x: 100, y: 200, width: 800, height: 600 },
      { width: 1_600, height: 1_200 },
      { locationsReliable: true, verifyDescendantLocations: true },
    );
    expect(tree?.root.children[0]?.bounds).toBeNull();
  });

  it("collapses anonymous wrapper chains and removes duplicate text fields", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: async () => [
          {
            role: "group",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            children: async () => [
              {
                role: "group",
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                children: async () => [
                  {
                    role: "button",
                    name: "Save",
                    value: "Save",
                    description: "Save",
                    bounds: { x: 20, y: 30, width: 80, height: 24 },
                    actions: ["press"],
                    children: async () => [],
                  },
                  {
                    role: "group",
                    bounds: null,
                    children: async () => [],
                  },
                ],
              },
            ],
          },
        ],
      },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 800, height: 600 },
    );

    expect(tree?.root.children).toEqual([
      {
        role: "button",
        name: "Save",
        bounds: { x: 20, y: 30, width: 80, height: 24 },
        actions: ["press"],
        children: [],
      },
    ]);
  });

  it("marks trees truncated before their serialized payload grows without bound", async () => {
    const tree = await accessibleWindowElementTree(
      {
        role: "window",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: async () =>
          Array.from({ length: 10 }, (_, index) => ({
            role: "text",
            value: `${index}${"x".repeat(8_000)}`,
            bounds: null,
            children: async () => [],
          })),
      },
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 800, height: 600 },
    );

    expect(tree?.truncated).toBe(true);
    expect(tree?.root.children.length).toBeLessThan(10);
    expect(JSON.stringify(tree).length).toBeLessThanOrEqual(32_000);
  });
});

describe("compactAccessibilityTree", () => {
  it("keeps anonymous groups that organize multiple semantic children", () => {
    const compacted = compactAccessibilityTree({
      role: "window",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        {
          role: "group",
          bounds: { x: 0, y: 0, width: 800, height: 100 },
          children: [
            { role: "button", name: "Back", bounds: null, children: [] },
            { role: "button", name: "Forward", bounds: null, children: [] },
          ],
        },
      ],
    });

    expect(compacted.root.children[0]?.role).toBe("group");
    expect(compacted.root.children[0]?.children).toHaveLength(2);
  });
});

describe("capturedImageBounds", () => {
  it("clips locations to the attached image", () => {
    expect(
      capturedImageBounds(
        { x: 50, y: 150, width: 200, height: 200 },
        { x: 100, y: 200, width: 800, height: 600 },
        { width: 1_600, height: 1_200 },
      ),
    ).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  });

  it("returns null when an accessibility provider omits a location", () => {
    expect(
      capturedImageBounds(
        null,
        { x: 0, y: 0, width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
    ).toBeNull();
  });
});

describe("findAccessibleWindow", () => {
  const captured = {
    title: "Editor",
    bounds: { x: 100, y: 200, width: 800, height: 600 },
  };

  it("matches one window by its captured bounds", () => {
    const windows = [
      { name: "Private", bounds: { x: 0, y: 0, width: 400, height: 300 } },
      { name: "Editor", bounds: { x: 101, y: 199, width: 800, height: 601 } },
    ];

    expect(findAccessibleWindow(windows, captured)).toBe(windows[1]);
  });

  it("uses the matched source title when macOS omits the active title", () => {
    const windows = [{ name: "Editor", bounds: captured.bounds }];
    expect(
      findAccessibleWindow(windows, {
        ...captured,
        title: "",
        sourceTitle: "Editor",
      }),
    ).toBe(windows[0]);
  });

  it("uses the captured source title when the active title changed", () => {
    const windows = [{ name: "Editor — saved", bounds: captured.bounds }];

    expect(
      findAccessibleWindow(windows, {
        ...captured,
        title: "Editor — saving",
        sourceTitle: "Editor — saved",
      }),
    ).toBe(windows[0]);
  });

  it("uses the active match to disambiguate equal windows", () => {
    const windows = [
      { name: "Editor", bounds: captured.bounds, active: false },
      { name: "Editor", bounds: captured.bounds, active: true },
    ];

    expect(findAccessibleWindow(windows, captured)).toBe(windows[1]);
  });

  it("does not match equal bounds with a different title", () => {
    expect(
      findAccessibleWindow(
        [{ name: "Private", bounds: { x: 100, y: 200, width: 800, height: 600 } }],
        captured,
      ),
    ).toBeUndefined();
  });

  it("does not use a title match when the bounds differ", () => {
    expect(
      findAccessibleWindow(
        [{ name: "Editor", bounds: { x: 0, y: 0, width: 800, height: 600 } }],
        captured,
      ),
    ).toBeUndefined();
  });

  it("matches a Wayland window whose accessibility provider omits its screen position", () => {
    const captured = {
      title: "hello world (Draft) - Text Editor",
      bounds: { x: 479, y: 342, width: 700, height: 520 },
    };
    const windows = [{ name: captured.title, bounds: { x: 0, y: 0, width: 700, height: 520 } }];

    expect(findAccessibleWindow(windows, captured, "wayland")).toBe(windows[0]);
    expect(findAccessibleWindow(windows, captured)).toBeUndefined();
  });

  it("matches a decorated Wayland window by its verified client size", () => {
    const clientBounds = { x: 100, y: 229, width: 800, height: 571 };
    const windows = [{ name: captured.title, bounds: { ...clientBounds, x: 0, y: 0 } }];
    expect(findAccessibleWindow(windows, { ...captured, clientBounds }, "wayland")).toBe(
      windows[0],
    );
    expect(findAccessibleWindow(windows, { ...captured, clientBounds })).toBeUndefined();
    expect(findAccessibleWindow(windows, captured, "wayland")).toBeUndefined();
  });

  it("does not guess between client-size and frame-size matches", () => {
    const clientBounds = { x: 100, y: 229, width: 800, height: 571 };
    const windows = [
      { name: captured.title, bounds: clientBounds },
      { name: captured.title, bounds: captured.bounds },
    ];
    expect(findAccessibleWindow(windows, { ...captured, clientBounds }, "wayland")).toBeUndefined();
    expect(
      findAccessibleWindow(
        [
          { name: "Private", bounds: clientBounds },
          { name: captured.title, bounds: { ...clientBounds, height: 550 } },
        ],
        { ...captured, clientBounds },
        "wayland",
      ),
    ).toBeUndefined();
  });

  it("distinguishes same-title Wayland windows by size", () => {
    const windows = [
      { name: "Editor", bounds: { x: 0, y: 0, width: 400, height: 300 } },
      { name: "Editor", bounds: { x: 0, y: 0, width: 801, height: 599 } },
    ];

    expect(findAccessibleWindow(windows, captured, "wayland")).toBe(windows[1]);
  });

  it.each([
    { name: "Private", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { name: "Editor", bounds: { x: 0, y: 0, width: 400, height: 600 } },
    { name: "Editor", bounds: { x: 0, y: 0, width: 800, height: 300 } },
    { name: "Editor", bounds: null },
  ])("rejects an unverified Wayland window: %j", (window) => {
    expect(findAccessibleWindow([window], captured, "wayland")).toBeUndefined();
  });

  it("rejects ambiguous Wayland windows even when one reports the captured screen position", () => {
    const windows = [
      { name: "Editor", bounds: captured.bounds },
      { name: "Editor", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ];

    expect(findAccessibleWindow(windows, captured, "wayland")).toBeUndefined();
  });

  it("does not match an untitled Wayland window by size alone", () => {
    const windows = [{ name: "", bounds: captured.bounds }];

    expect(findAccessibleWindow(windows, { ...captured, title: "" }, "wayland")).toBeUndefined();
  });

  it.each(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])(
    "ignores a leading Wayland title spinner frame %s",
    (frame) => {
      const windows = [{ name: `${frame} t3code`, bounds: captured.bounds }];

      expect(findAccessibleWindow(windows, { ...captured, title: "⠋ t3code" }, "wayland")).toBe(
        windows[0],
      );
    },
  );

  it.each([
    ["⠋ t3code", "t3code"],
    ["t3code", "⠙ t3code"],
  ])("matches a Wayland spinner starting or stopping: %s → %s", (title, name) => {
    const windows = [{ name, bounds: captured.bounds }];

    expect(findAccessibleWindow(windows, { ...captured, title }, "wayland")).toBe(windows[0]);
  });

  it.each([
    ["⠋ t3code", "⠙ private"],
    ["t3code ⠋", "t3code ⠙"],
    ["⠋t3code", "⠙t3code"],
    ["⠁ t3code", "⠙ t3code"],
    ["⠋", "⠋"],
  ])("does not guess a Wayland title match: %s → %s", (title, name) => {
    expect(
      findAccessibleWindow([{ name, bounds: captured.bounds }], { ...captured, title }, "wayland"),
    ).toBeUndefined();
  });

  it("rejects matching spinners when the window sizes differ", () => {
    expect(
      findAccessibleWindow(
        [{ name: "⠙ t3code", bounds: { ...captured.bounds, width: 400 } }],
        { ...captured, title: "⠋ t3code" },
        "wayland",
      ),
    ).toBeUndefined();
  });

  it("rejects ambiguous normalized titles even if one matches the captured spinner exactly", () => {
    const windows = [
      { name: "⠋ t3code", bounds: captured.bounds },
      { name: "⠙ t3code", bounds: captured.bounds },
    ];

    expect(
      findAccessibleWindow(windows, { ...captured, title: "⠋ t3code" }, "wayland"),
    ).toBeUndefined();
  });

  it("keeps exact title matching outside Wayland", () => {
    expect(
      findAccessibleWindow([{ name: "⠙ t3code", bounds: captured.bounds }], {
        ...captured,
        title: "⠋ t3code",
      }),
    ).toBeUndefined();
  });
});

describe("hideAndWaitForBlur", () => {
  it("waits for a delayed blur after hiding the window", async () => {
    let blur: (() => void) | undefined;
    let settled = false;
    const hidden = hideAndWaitForBlur({
      hide: () => undefined,
      once: (_event, listener) => {
        blur = listener;
      },
      removeListener: () => undefined,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    blur?.();
    await hidden;
    expect(settled).toBe(true);
  });

  it("rejects when the hidden window never blurs", async () => {
    vi.useFakeTimers();
    try {
      let rejected = false;
      const hidden = hideAndWaitForBlur({
        hide: () => undefined,
        once: () => undefined,
        removeListener: () => undefined,
      }).catch(() => {
        rejected = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(rejected).toBe(true);
      await hidden;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("toElectronAccelerator", () => {
  it("converts the default portable shortcut", () => {
    expect(
      toElectronAccelerator({
        key: "2",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    ).toBe("CommandOrControl+Shift+2");
  });

  it("maps the portable meta key to Super", () => {
    expect(
      toElectronAccelerator({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: false,
      }),
    ).toBe("Super+K");
  });

  it("normalizes Electron key names", () => {
    expect(
      toElectronAccelerator({
        key: "ArrowUp",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: true,
        modKey: false,
      }),
    ).toBe("Control+Alt+Up");
  });
});

describe("findCaptureSource", () => {
  const sources = [
    { id: "window:42:0", name: "Terminal" },
    { id: "window:84:0", name: "Editor" },
  ];

  it("matches the native window id before its title", () => {
    expect(
      findCaptureSource(sources, {
        id: 84,
        title: "Changed title",
      }),
    ).toEqual(sources[1]);
  });

  it("falls back to a unique title match", () => {
    expect(
      findCaptureSource(sources, {
        id: 100,
        title: "Terminal",
      }),
    ).toEqual(sources[0]);
  });

  it("does not guess when a title is ambiguous", () => {
    expect(
      findCaptureSource(
        [
          { id: "window:42:0", name: "Editor" },
          { id: "window:84:0", name: "Editor" },
        ],
        {
          id: 100,
          title: "Editor",
        },
      ),
    ).toBeUndefined();
  });
});

describe("isWaylandSession", () => {
  it.each([
    ["linux", { XDG_SESSION_TYPE: "wayland" }, true],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
    ["linux", { XDG_SESSION_TYPE: "x11" }, false],
    ["darwin", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, false],
  ] as const)("detects %s session %o as portal=%s", (platform, environment, expected) => {
    expect(isWaylandSession(platform, environment)).toBe(expected);
  });

  effectIt.effect(
    "falls back to a live runtime directory socket when session variables are stripped",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) !== "linux") return;
        yield* Effect.promise(async () => {
          const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
          const { createServer } = await import("node:net");
          const { tmpdir } = await import("node:os");
          const { join } = await import("node:path");
          const runtimeDirectory = await mkdtemp(join(tmpdir(), "t3-wayland-"));
          const socketPath = join(runtimeDirectory, "wayland-0");
          const server = createServer();
          try {
            expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory })).toBe(false);
            await writeFile(socketPath, "");
            expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory })).toBe(false);
            await rm(socketPath);
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(socketPath, resolve);
            });
            expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: runtimeDirectory })).toBe(true);
            expect(
              isWaylandSession("linux", {
                XDG_RUNTIME_DIR: runtimeDirectory,
                XDG_SESSION_TYPE: "x11",
              }),
            ).toBe(false);
            expect(isWaylandSession("linux", { XDG_RUNTIME_DIR: "/nonexistent-t3-test" })).toBe(
              false,
            );
          } finally {
            if (server.listening) {
              await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              });
            }
            await rm(runtimeDirectory, { recursive: true, force: true });
          }
        });
      }),
  );
});

describe("snapShotShortcutRegistrationFailureMessage", () => {
  it("distinguishes a modifier listener failure from a reserved key chord", () => {
    expect(
      snapShotShortcutRegistrationFailureMessage({ kind: "both-shift-keys" }, "darwin"),
    ).toMatch(/Shift \+ Shift is not available/);
    expect(
      snapShotShortcutRegistrationFailureMessage(
        { kind: "modifier-pair", modifier: "meta" },
        "darwin",
      ),
    ).toMatch(/Command \+ Command is not available/);
    expect(
      snapShotShortcutRegistrationFailureMessage(
        { kind: "modifier-pair", modifier: "meta" },
        "linux",
      ),
    ).toMatch(/Super \+ Super is not available/);
    expect(
      snapShotShortcutRegistrationFailureMessage(
        {
          key: "2",
          metaKey: false,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          modKey: true,
        },
        "darwin",
      ),
    ).toMatch(/already used/);
  });
});

describe("snapShotShortcutSystemConflict", () => {
  it("blocks shortcuts that would break typing or common app actions", () => {
    expect(
      snapShotShortcutSystemConflict({
        key: "s",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: false,
      }),
    ).toMatch(/typing/);
    expect(
      snapShotShortcutSystemConflict({
        key: "c",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      }),
    ).toMatch(/Copy/);
  });

  it("allows a specific multi-modifier shortcut", () => {
    expect(
      snapShotShortcutSystemConflict({
        key: "2",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    ).toBeNull();
  });
});
