import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  htmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "./HtmlRender.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

// Real-browser tests run only when this names a chrome-headless-shell, for
// example one T3 installed under <T3 home>/tools/chrome-headless-shell.
const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

const htmlRenderLayer = (executable?: string) =>
  HtmlRender.layer.pipe(
    Layer.provide(
      Layer.succeed(
        PreviewBrowser.PreviewBrowser,
        PreviewBrowser.PreviewBrowser.of({
          executable:
            executable === undefined
              ? Effect.die("This test has no preview browser.")
              : Effect.succeed(executable),
          installed: Effect.succeed(Option.fromUndefinedOr(executable)),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-render-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const testLayer = htmlRenderLayer();

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("HtmlRender", () => {
  it.effect("inlines local images by absolute path and leaves URLs and relative paths alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-images-" });
      const png = path.join(directory, "shot.png");
      const svg = path.join(directory, "logo.svg");
      yield* fileSystem.writeFile(png, PNG_BYTES);
      yield* fileSystem.writeFileString(svg, "<svg/>");
      const kept = [
        "https://example.com/a.png",
        "//cdn.example.com/b.png",
        "./c.png",
        "data:image/png;base64,AAAA",
      ];

      const prepared = yield* htmlRender.prepare(
        [
          "<!doctype html><html><head><title>Shots</title></head><body>",
          `<img src="${png}"><div style="background:url(${svg})"></div>`,
          `<script>const shots = ['${png}', \`${svg}\`];</script>`,
          ...kept.map((src) => `<img src="${src}">`),
          "</body></html>",
        ].join(""),
      );

      const pngUri = `data:image/png;base64,${Encoding.encodeBase64(PNG_BYTES)}`;
      const svgUri = `data:image/svg+xml;base64,${Encoding.encodeBase64("<svg/>")}`;
      expect(prepared).toContain(`<img src="${pngUri}">`);
      expect(prepared).toContain(`url(${svgUri})`);
      expect(prepared).toContain(`['${pngUri}', \`${svgUri}\`]`);
      expect(prepared).not.toContain(directory);
      for (const src of kept) expect(prepared).toContain(`<img src="${src}">`);
      // The theme bootstrap opens the head, ahead of the page's own markup.
      expect(prepared.indexOf("<head>")).toBeLessThan(prepared.indexOf('<style id="t3-theme">'));
      expect(prepared.indexOf('<style id="t3-theme">')).toBeLessThan(prepared.indexOf("<title>"));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("lists every local image it cannot read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-images-" });
      const folder = path.join(directory, "folder.png");
      yield* fileSystem.makeDirectory(folder);
      const missing = path.join(directory, "missing.jpg");

      const error = yield* htmlRender
        .prepare(`<img src="${missing}"><img src='${folder}'><img src="C:\\nope\\shot.webp">`)
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(HtmlRender.HtmlRenderImagesNotFoundError);
      expect(error._tag === "HtmlRenderImagesNotFoundError" && error.paths).toEqual([
        missing,
        folder,
        "C:\\nope\\shot.webp",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes the prepared page as an html thread attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const htmlRender = yield* HtmlRender.HtmlRender;

      const reference = yield* htmlRender.publish({
        threadId: ThreadId.make("thread-html-render"),
        html: "<p>Quarterly revenue</p>",
        title: "  Revenue  ",
        height: 9_000,
      });

      // Without an installed preview browser the page publishes unmeasured.
      expect(reference).toEqual({
        attachmentId: expect.any(String),
        title: "Revenue",
        height: 2_000,
      });
      const stored = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: reference.attachmentId,
      });
      expect(stored?.endsWith(".html")).toBe(true);
      const html = yield* fileSystem.readFileString(stored ?? "");
      expect(html).toContain('<style id="t3-theme">');
      expect(html).toContain("<p>Quarterly revenue</p>");
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "screenshots the page in headless Chrome with the requested theme and every console level",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcessEnvironment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        yield* Effect.gen(function* () {
          const htmlRender = yield* HtmlRender.HtmlRender;
          const preview = yield* htmlRender.preview({
            html: [
              '<!doctype html><html><head></head><body><div style="height:300px;background:var(--accent)"></div>',
              '<img src="/nonexistent/t3-missing.png" hidden>',
              "<script>",
              "const root = getComputedStyle(document.documentElement);",
              'console.log("ready", 3); console.info(root.getPropertyValue("--font-sans"));',
              'console.warn(root.getPropertyValue("--background")); console.error("boom");',
              "</script>",
              '<script>throw new Error("broken chart");</script>',
              "</body></html>",
            ].join(""),
            width: 400,
            appearance: "dark",
          });

          const png = Buffer.from(preview.png, "base64");
          expect(png.readUInt32BE(0)).toBe(0x89504e47);
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([400, 300]);
          expect(preview).toMatchObject({
            width: 400,
            contentHeight: 300,
            capturedHeight: 300,
            missingImages: ["/nonexistent/t3-missing.png"],
          });
          // Headless Chrome prefers light, so a dark background proves the theme fragment applied.
          expect(preview.consoleMessages).toEqual(
            expect.arrayContaining([
              { level: "log", text: "ready 3" },
              { level: "info", text: HTML_RENDER_MEASURE_FONTS.sans },
              {
                level: "warning",
                text: htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark").variables["--background"],
              },
              { level: "error", text: "boom" },
              {
                level: "error",
                text: expect.stringMatching(/^Error: broken chart\n\s+at page\.html:1:\d+$/),
              },
            ]),
          );
        }).pipe(Effect.provide(htmlRenderLayer(executable)));
      }),
    30_000,
  );

  it.live(
    "measures a published page at every client width with a fresh load each",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcessEnvironment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        yield* Effect.gen(function* () {
          const htmlRender = yield* HtmlRender.HtmlRender;
          // Like a D3 chart, the page sizes itself from the width once, at load.
          const reference = yield* htmlRender.publish({
            threadId: ThreadId.make("thread-html-measure"),
            html: '<div id="chart"></div><script>document.getElementById("chart").style.height = innerWidth / 2 + "px";</script>',
            title: "Chart",
            height: 600,
          });

          expect(reference.heights).toEqual(
            HTML_RENDER_MEASURE_WIDTHS.map((width) => [width, Math.ceil(width / 2)]),
          );
        }).pipe(Effect.provide(htmlRenderLayer(executable)));
      }),
    30_000,
  );
});
