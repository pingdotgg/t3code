import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterAll } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as NativeAppIconResolver from "../NativeAppIconResolver.ts";
import { parseDesktopEntry, rankDesktopEntry } from "./linux.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-linux-app-icons-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

function write(relative: string, contents: string) {
  const filePath = NodePath.join(root, relative);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, contents);
  return filePath;
}

const CHROMIUM_DESKTOP = `[Desktop Entry]
Version=1.0
Name=Chromium
Name[de]=Chromium Webbrowser
Comment=Access the Internet
Exec=/usr/bin/chromium %U
Icon=chromium
Type=Application
StartupWMClass=Chromium-browser
Categories=Network;WebBrowser;

[Desktop Action new-window]
Name=New Window
Exec=/usr/bin/chromium
`;

describe("parseDesktopEntry", () => {
  it("keeps only the Desktop Entry group and skips hidden launchers", () => {
    expect(parseDesktopEntry(CHROMIUM_DESKTOP, "chromium")).toEqual({
      name: "Chromium",
      icon: "chromium",
      wmClass: "Chromium-browser",
      fileStem: "chromium",
    });
    expect(
      parseDesktopEntry("[Desktop Entry]\nName=Helper\nIcon=helper\nNoDisplay=true\n", "helper"),
    ).toBeUndefined();
    expect(parseDesktopEntry("[Desktop Entry]\nName=NoIcon\n", "noicon")).toBeUndefined();
  });
});

describe("rankDesktopEntry", () => {
  const chromium = parseDesktopEntry(CHROMIUM_DESKTOP, "chromium")!;
  it("prefers the window class over name prefixes", () => {
    expect(
      rankDesktopEntry(chromium, { _tag: "display-name", displayName: "Chromium-browser" }),
    ).toBe(5);
    expect(rankDesktopEntry(chromium, { _tag: "display-name", displayName: "chromium" })).toBe(3);
    expect(
      rankDesktopEntry(chromium, { _tag: "display-name", displayName: "Chromium-nightly" }),
    ).toBe(2);
    expect(rankDesktopEntry(chromium, { _tag: "display-name", displayName: "Firefox" })).toBe(0);
    expect(rankDesktopEntry(chromium, { _tag: "app-id", appId: "chromium" })).toBe(4);
  });
});

describe("linux native app icons", () => {
  const dataDir = NodePath.join(root, "share");
  const homeDir = NodePath.join(root, "home");
  write("share/applications/chromium.desktop", CHROMIUM_DESKTOP);
  write("share/applications/broken.desktop", "not an ini");
  const png = write("share/icons/hicolor/64x64/apps/chromium.png", "png");
  write("share/icons/hicolor/16x16/apps/chromium.png", "tiny");
  const sketchSvg = write("opt/sketch/icon.svg", "<svg/>");
  write(
    "home/.local/share/applications/sketch.desktop",
    `[Desktop Entry]\nName=Sketch\nIcon=${sketchSvg}\nStartupWMClass=sketch\n`,
  );
  write(
    "home/.local/share/applications/escape.desktop",
    "[Desktop Entry]\nName=Escape\nIcon=../../../etc/passwd\nStartupWMClass=escape\n",
  );
  write(
    "share/applications/svgonly.desktop",
    "[Desktop Entry]\nName=Vector\nIcon=vector\nStartupWMClass=vector\n",
  );
  const svg = write("share/icons/hicolor/scalable/apps/vector.svg", "<svg/>");

  const dependencies = Layer.mergeAll(
    ServerConfig.ServerConfig.layerTest(root, { prefix: "t3-linux-app-icon-" }),
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessEnvironment, {
      HOME: homeDir,
      XDG_DATA_DIRS: `${dataDir}:/nonexistent`,
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = NativeAppIconResolver.layer.pipe(Layer.provide(dependencies));

  it.effect("resolves a window class through its launcher to the best hicolor size", () =>
    Effect.gen(function* () {
      const resolver = yield* NativeAppIconResolver.NativeAppIconResolver;
      expect(
        yield* resolver.resolve({ _tag: "display-name", displayName: "Chromium-browser" }),
      ).toBe(png);
      expect(yield* resolver.resolve({ _tag: "display-name", displayName: "Chromium" })).toBe(png);
      expect(yield* resolver.resolve({ _tag: "display-name", displayName: "Firefox" })).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves absolute and scalable icons but refuses relative escapes", () =>
    Effect.gen(function* () {
      const resolver = yield* NativeAppIconResolver.NativeAppIconResolver;
      expect(yield* resolver.resolve({ _tag: "display-name", displayName: "sketch" })).toBe(
        sketchSvg,
      );
      expect(yield* resolver.resolve({ _tag: "display-name", displayName: "vector" })).toBe(svg);
      expect(yield* resolver.resolve({ _tag: "display-name", displayName: "escape" })).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("resolves nothing on a platform without a source", () =>
    Effect.gen(function* () {
      const resolver = yield* NativeAppIconResolver.NativeAppIconResolver;
      expect(
        yield* resolver.resolve({ _tag: "display-name", displayName: "Chromium-browser" }),
      ).toBeNull();
    }).pipe(
      Effect.provide(
        NativeAppIconResolver.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerConfig.ServerConfig.layerTest(root, { prefix: "t3-win-app-icon-" }),
              Layer.succeed(HostProcessPlatform, "win32"),
              Layer.succeed(HostProcessEnvironment, { HOME: homeDir, XDG_DATA_DIRS: dataDir }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
      ),
    ),
  );
});
