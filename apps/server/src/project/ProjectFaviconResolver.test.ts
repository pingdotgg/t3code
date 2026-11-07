import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-favicon-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const writeAppIconSet = Effect.fn("writeAppIconSet")(function* (
  cwd: string,
  relativePath: string,
  images: ReadonlyArray<{ readonly filename: string; readonly [key: string]: unknown }>,
) {
  yield* writeTextFile(cwd, `${relativePath}/Contents.json`, JSON.stringify({ images }));
  for (const image of images) {
    yield* writeTextFile(cwd, `${relativePath}/${image.filename}`, "icon");
  }
});

const makeResolverWithFileSystem = (fileSystem: FileSystem.FileSystem) =>
  ProjectFaviconResolver.make.pipe(
    Effect.provide([WorkspacePaths.layer, T3ProjectFileLoader.layer]),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

it.layer(layerTest)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("finds a favicon added after a cached miss once the workspace is invalidated", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        // A clone's project exists while its folder is still empty.
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        yield* writeTextFile(cwd, "favicon.ico", "icon");
        expect(yield* resolver.resolvePath(cwd)).toBeNull();

        yield* resolver.invalidate(cwd);
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.ico"));
      }),
    );

    it.effect("falls back at once when a cached favicon is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        expect(yield* resolver.resolvePath(cwd)).not.toBeNull();

        yield* fileSystem.remove(path.join(cwd, "favicon.svg")).pipe(Effect.orDie);

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("prefers a t3.json iconPath over well-known files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/mark.svg" }');
        yield* writeTextFile(cwd, "brand/mark.svg", "<svg>mark</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(cwd, "brand", "mark.svg"));
      }),
    );

    it.effect("uses a saved project favicon override", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/custom.svg", "<svg>custom</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/custom.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(cwd, "brand", "custom.svg"));
      }),
    );

    it.effect("uses a saved project favicon outside the workspace", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(pictures, "custom.png", "image");
        const externalPath = path.join(pictures, "custom.png");

        const resolved = yield* resolver.resolvePath(cwd, externalPath);

        expect(resolved).toBe(externalPath);
      }),
    );

    it.effect("falls back when a saved override is missing from a checkout", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/missing.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("ignores invalid t3.json files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", "{ not json");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("does not resolve a t3.json iconPath outside the workspace root", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const parent = yield* makeTempDir;
        const cwd = `${parent}/app`;
        yield* writeTextFile(parent, "secret.svg", "<svg>secret</svg>");
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "../secret.svg" }');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("resolves icon hrefs from object-literal route metadata", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/routes/__root.tsx",
          `export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: "stylesheet", href: "/app.css" },
      { rel: "icon", href: "/brand/logo.svg" },
    ],
  }),
});`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    // regression: #5538 favicon resolution pinned the event loop
    it.effect("skips icon metadata without an href and keeps scanning", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ rel: "icon" }, { rel: "icon", href: "/brand/logo.svg" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("returns a found favicon without waiting for lower-ranked probes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>root</svg>");
        const stuckPath = path.join(cwd, "favicon.ico");
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) => (filePath === stuckPath ? Effect.never : fileSystem.stat(filePath)),
          }),
        );

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
      }),
    );

    it.effect("uses the icon an Expo app.json declares", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "app.json",
          JSON.stringify({ expo: { icon: "./images/brand-icon.png" } }),
        );
        yield* writeTextFile(cwd, "images/brand-icon.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "images/brand-icon.png"));
      }),
    );

    it.effect("prefers the iOS icon an Expo app.json declares", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "app.json",
          JSON.stringify({ expo: { icon: "./common.png", ios: { icon: "./ios.png" } } }),
        );
        yield* writeTextFile(cwd, "common.png", "icon");
        yield* writeTextFile(cwd, "ios.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "ios.png"));
      }),
    );

    it.effect("uses the light variant of an Expo iOS icon", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "app.json",
          JSON.stringify({ expo: { ios: { icon: { dark: "./dark.png", light: "./light.png" } } } }),
        );
        yield* writeTextFile(cwd, "dark.png", "icon");
        yield* writeTextFile(cwd, "light.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "light.png"));
      }),
    );

    it.effect("reads an Expo app.json without the expo wrapper", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "app.json", JSON.stringify({ icon: "./images/main.png" }));
        yield* writeTextFile(cwd, "images/main.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "images/main.png"));
      }),
    );

    it.effect("ignores an Expo icon outside the workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const parent = yield* makeTempDir;
        const cwd = path.join(parent, "workspace");
        yield* writeTextFile(parent, "secret.png", "icon");
        yield* writeTextFile(cwd, "app.json", JSON.stringify({ expo: { icon: "../secret.png" } }));

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }),
    );

    it.effect("bounds the reads an app icon search makes across many catalogs", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        for (let index = 0; index < 300; index += 1) {
          yield* writeTextFile(
            cwd,
            `Catalog${index}.xcassets/AppIcon.appiconset/Contents.json`,
            JSON.stringify({ images: [] }),
          );
        }
        let reads = 0;
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (...args) => {
              reads += 1;
              return fileSystem.readDirectory(...args);
            },
            readFileString: (filePath, encoding) => {
              if (filePath.endsWith("Contents.json")) reads += 1;
              return fileSystem.readFileString(filePath, encoding);
            },
          }),
        );

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        expect(reads).toBeLessThanOrEqual(256);
      }),
    );

    it.effect("tolerates a malformed app.json", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "app.json", "{ not json");
        yield* writeAppIconSet(cwd, "App/Assets.xcassets/AppIcon.appiconset", [
          { filename: "icon.png", idiom: "universal", size: "1024x1024" },
        ]);

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "App/Assets.xcassets/AppIcon.appiconset/icon.png"),
        );
      }),
    );

    it.effect("finds app icons in native, React Native, and Capacitor layouts", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        for (const catalog of [
          "MyApp/Assets.xcassets",
          "ios/MyApp/Images.xcassets",
          "ios/App/App/Assets.xcassets",
          "apps/ios/MyApp/Assets.xcassets",
        ]) {
          const cwd = yield* makeTempDir;
          yield* writeAppIconSet(cwd, `${catalog}/AppIcon.appiconset`, [
            { filename: "icon.png", idiom: "universal", size: "1024x1024" },
          ]);

          expect(yield* resolver.resolvePath(cwd)).toBe(
            path.join(cwd, catalog, "AppIcon.appiconset/icon.png"),
          );
        }
      }),
    );

    it.effect("picks the smallest app icon that stays sharp", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeAppIconSet(cwd, "App/Assets.xcassets/AppIcon.appiconset", [
          { filename: "20.png", idiom: "iphone", scale: "2x", size: "20x20" },
          { filename: "60.png", idiom: "iphone", scale: "2x", size: "60x60" },
          { filename: "60@3.png", idiom: "iphone", scale: "3x", size: "60x60" },
          { filename: "1024.png", idiom: "ios-marketing", scale: "1x", size: "1024x1024" },
        ]);

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "App/Assets.xcassets/AppIcon.appiconset/60.png"),
        );
      }),
    );

    it.effect("skips dark and tinted app icon variants", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeAppIconSet(cwd, "App/Assets.xcassets/AppIcon.appiconset", [
          {
            appearances: [{ appearance: "luminosity", value: "dark" }],
            filename: "dark.png",
            idiom: "universal",
            size: "1024x1024",
          },
          { filename: "light.png", idiom: "universal", size: "1024x1024" },
        ]);

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "App/Assets.xcassets/AppIcon.appiconset/light.png"),
        );
      }),
    );

    it.effect("treats empty app icon appearances as the default icon", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeAppIconSet(cwd, "App/Assets.xcassets/AppIcon.appiconset", [
          { appearances: [], filename: "icon.png", idiom: "universal", size: "1024x1024" },
        ]);

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "App/Assets.xcassets/AppIcon.appiconset/icon.png"),
        );
      }),
    );

    it.effect("bounds the file checks for images an app icon set lists", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "App/Assets.xcassets/AppIcon.appiconset/Contents.json",
          JSON.stringify({
            images: Array.from({ length: 1000 }, (_, index) => ({ filename: `${index}.png` })),
          }),
        );
        let checks = 0;
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) => {
              if (filePath.includes(".appiconset")) checks += 1;
              return fileSystem.stat(filePath);
            },
          }),
        );

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        expect(checks).toBeLessThanOrEqual(256);
      }),
    );

    it.effect("prefers the app's icon over its extensions and alternates", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const image = [{ filename: "icon.png", idiom: "universal", size: "1024x1024" }];
        yield* writeAppIconSet(cwd, "AppWatch/Assets.xcassets/AppIcon.appiconset", image);
        yield* writeAppIconSet(cwd, "AppWidget/Assets.xcassets/AppIcon.appiconset", image);
        yield* writeAppIconSet(cwd, "Zebra/Assets.xcassets/AppIcon-blue.appiconset", image);
        yield* writeAppIconSet(cwd, "Zebra/Assets.xcassets/AppIcon.appiconset", image);

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "Zebra/Assets.xcassets/AppIcon.appiconset/icon.png"),
        );
      }),
    );

    it.effect("skips an app icon set with no image and keeps looking", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "App/Assets.xcassets/AppIcon.appiconset/Contents.json",
          JSON.stringify({ images: [{ idiom: "universal", size: "1024x1024" }] }),
        );
        yield* writeAppIconSet(cwd, "Other/Assets.xcassets/AppIcon.appiconset", [
          { filename: "icon.png", idiom: "universal", size: "1024x1024" },
        ]);

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "Other/Assets.xcassets/AppIcon.appiconset/icon.png"),
        );
      }),
    );

    it.effect("does not search dependency folders for app icons", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        for (const dependency of ["node_modules/pkg", "ios/Pods/Lib", "build/App"]) {
          yield* writeAppIconSet(cwd, `${dependency}/Assets.xcassets/AppIcon.appiconset`, [
            { filename: "icon.png", idiom: "universal", size: "1024x1024" },
          ]);
        }

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }),
    );

    it.effect("uses the Android icon an Expo app.json declares", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "app.json",
          JSON.stringify({ expo: { android: { icon: "./android-icon.png" } } }),
        );
        yield* writeTextFile(cwd, "android-icon.png", "icon");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "android-icon.png"));
      }),
    );

    it.effect("finds launcher icons in Android layouts", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        for (const icon of [
          "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
          "app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp",
        ]) {
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, icon, "icon");

          expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, icon));
        }
      }),
    );

    it.effect("picks the smallest launcher icon that stays sharp", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        for (const density of ["mdpi", "hdpi", "xhdpi", "xxxhdpi"]) {
          yield* writeTextFile(cwd, `app/src/main/res/mipmap-${density}/ic_launcher.png`, "icon");
        }

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "app/src/main/res/mipmap-xhdpi/ic_launcher.png"),
        );
      }),
    );

    it.effect("ignores adaptive launcher icons that are only XML", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", "<xml />");

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }),
    );

    it.effect("prefers existing web icons over app icons", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "public/favicon.svg", "<svg>web</svg>");
        yield* writeAppIconSet(cwd, "App/Assets.xcassets/AppIcon.appiconset", [
          { filename: "icon.png", idiom: "universal", size: "1024x1024" },
        ]);

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "public/favicon.svg"));
      }),
    );

    it.effect("skips icon metadata paths outside the workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../secret.svg">');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );
  });
});
