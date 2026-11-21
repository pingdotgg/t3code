import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, vi } from "vite-plus/test";

const electronMock = vi.hoisted(() => {
  interface FakeTray {
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }
  const trays: FakeTray[] = [];
  const resizedImage = { isEmpty: vi.fn(() => false) };
  const resize = vi.fn(() => resizedImage);
  const createFromPath = vi.fn(() => ({ resize }));
  const createTray = function (this: FakeTray) {
    this.setToolTip = vi.fn();
    this.setContextMenu = vi.fn();
    this.on = vi.fn();
    this.destroy = vi.fn();
    trays.push(this);
  };
  const Tray = vi.fn(createTray);
  const buildFromTemplate = vi.fn(() => ({}));
  return { trays, resizedImage, resize, createFromPath, createTray, Tray, buildFromTemplate };
});

vi.mock("electron", () => ({
  Tray: electronMock.Tray,
  Menu: { buildFromTemplate: electronMock.buildFromTemplate },
  nativeImage: { createFromPath: electronMock.createFromPath },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

beforeEach(() => {
  electronMock.trays.length = 0;
  electronMock.Tray.mockReset().mockImplementation(electronMock.createTray);
  electronMock.buildFromTemplate.mockClear();
  electronMock.createFromPath.mockClear();
  electronMock.resize.mockClear();
  electronMock.resizedImage.isEmpty.mockReset().mockReturnValue(false);
});

function layerTest(input: {
  readonly platform: NodeJS.Platform;
  readonly ico?: string | undefined;
  readonly png?: string | undefined;
  readonly settings?: Option.Option<ClientSettings>;
}) {
  const layerDesktopEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/home/alice",
    platform: input.platform,
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
  return DesktopTray.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopState.layer,
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.fromNullishOr(input.ico),
            icns: Option.none<string>(),
            png: Option.fromNullishOr(input.png),
          }),
          resolveResourcePath: () => Effect.succeed(Option.none<string>()),
        } satisfies DesktopAssets.DesktopAssets["Service"]),
        layerDesktopEnvironment,
        Layer.mock(DesktopWindow.DesktopWindow)({
          activate: Effect.void,
        }),
        Layer.mock(ElectronApp.ElectronApp)({
          quit: Effect.void,
        }),
        DesktopClientSettings.layerTest(input.settings ?? Option.none()),
      ),
    ),
  );
}

describe("DesktopTray", () => {
  it.effect("creates one tray on win32, then destroys it when the setting turns off", () =>
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;

      yield* tray.configure(true);
      assert.equal(electronMock.trays.length, 1);
      assert.isTrue(yield* Ref.get(state.closeToTray));

      yield* tray.configure(true);
      assert.equal(electronMock.trays.length, 1);

      yield* tray.configure(false);
      assert.equal(electronMock.trays[0]!.destroy.mock.calls.length, 1);
      assert.isFalse(yield* Ref.get(state.closeToTray));
    }).pipe(
      Effect.provide(layerTest({ platform: "win32", ico: "C:\\icons\\t3.ico" })),
      Effect.scoped,
    ),
  );

  it.effect.each(["initialize", "configure"] as const)(
    "recovers from menu setup failure during %s",
    (operation) =>
      Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        const state = yield* DesktopState.DesktopState;
        electronMock.buildFromTemplate.mockImplementationOnce(() => {
          throw new Error("menu unavailable");
        });
        yield* operation === "initialize" ? tray.initialize : tray.configure(true);
        assert.isFalse(yield* Ref.get(state.closeToTray));
        assert.equal(electronMock.trays[0]!.destroy.mock.calls.length, 1);
        yield* tray.configure(true);
        assert.equal(electronMock.trays.length, 2);
        assert.isTrue(yield* Ref.get(state.closeToTray));
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "win32",
            ico: "icon.ico",
            settings: Option.some({ ...DEFAULT_CLIENT_SETTINGS, keepRunningInTray: true }),
          }),
        ),
        Effect.scoped,
      ),
  );

  it.effect.each([
    {
      name: "darwin never creates a tray",
      platform: "darwin" as const,
      ico: "icon.ico",
      png: "icon.png",
      throwOnConstruct: false,
    },
    {
      name: "a missing icon path never creates a tray",
      platform: "win32" as const,
      ico: undefined,
      png: undefined,
      throwOnConstruct: false,
    },
    {
      name: "a throwing Tray constructor never creates a tray",
      platform: "win32" as const,
      ico: "icon.ico",
      png: undefined,
      throwOnConstruct: true,
    },
  ])("$name leaves closeToTray off", ({ platform, ico, png, throwOnConstruct }) =>
    Effect.gen(function* () {
      if (throwOnConstruct) {
        electronMock.Tray.mockImplementation(function () {
          throw new Error("tray unavailable");
        });
      }
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;

      yield* tray.configure(true);
      yield* tray.configure(true);

      assert.equal(electronMock.trays.length, 0);
      assert.isFalse(yield* Ref.get(state.closeToTray));
    }).pipe(Effect.provide(layerTest({ platform, ico, png })), Effect.scoped),
  );

  it.effect.each([
    {
      name: "turns closeToTray on when the setting is enabled",
      settings: Option.some<ClientSettings>({
        ...DEFAULT_CLIENT_SETTINGS,
        keepRunningInTray: true,
      }),
      expected: true,
    },
    {
      name: "stays off without stored settings",
      settings: Option.none<ClientSettings>(),
      expected: false,
    },
  ])("initialize $name", ({ settings, expected }) =>
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;

      yield* tray.initialize;

      assert.equal(yield* Ref.get(state.closeToTray), expected);
      assert.equal(electronMock.trays.length, expected ? 1 : 0);
    }).pipe(
      Effect.provide(layerTest({ platform: "win32", ico: "icon.ico", settings })),
      Effect.scoped,
    ),
  );
});
