// @effect-diagnostics nodeBuiltinImport:off - plain local servers stand in for LAN services.
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "./HtmlRender.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

// Real-browser tests run only when this names a chrome-headless-shell, for
// example one T3 installed under <T3 home>/tools/chrome-headless-shell.
const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

const htmlRenderLayer = (
  executable?: string,
  installed: Effect.Effect<Option.Option<string>> = Effect.succeed(
    Option.fromUndefinedOr(executable),
  ),
) =>
  HtmlRender.layer.pipe(
    Layer.provide(
      Layer.succeed(
        PreviewBrowser.PreviewBrowser,
        PreviewBrowser.PreviewBrowser.of({
          executable:
            executable === undefined
              ? Effect.die("This test has no preview browser.")
              : Effect.succeed(executable),
          installed,
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

      const pngUri = `data:image/png;base64,${Base64.encode(PNG_BYTES)}`;
      const svgUri = `data:image/svg+xml;base64,${Base64.encode("<svg/>")}`;
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

  it.effect("inlines an SVG behind processing instructions and a doctype subset", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-images-" });
      const svg = path.join(directory, "styled.svg");
      const source = [
        '<?xml version="1.0"?>',
        '<?xml-stylesheet href="theme.css"?>',
        '<!DOCTYPE svg [ <!ENTITY fill "red"> ]>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
      ].join("\n");
      yield* fileSystem.writeFileString(svg, source);

      const prepared = yield* htmlRender.prepare(`<img src="${svg}">`);

      expect(prepared).toContain(`data:image/svg+xml;base64,${Base64.encode(source)}`);
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
      // Named like an image, but a symlink or renamed file must not carry other data.
      const secret = path.join(directory, "secret.png");
      yield* fileSystem.writeFileString(secret, "API_KEY=abc123");
      const report = path.join(directory, "report.svg");
      yield* fileSystem.writeFileString(report, "<!doctype html><body><svg></svg>API_KEY=abc123");
      // An <svg> inside a quoted entity, and a prolog shaped to stall a backtracking matcher.
      const config = path.join(directory, "config.svg");
      yield* fileSystem.writeFileString(
        config,
        '<!DOCTYPE config [<!ENTITY a "a"><!ENTITY b "]><svg/>">]><config>API_KEY=abc123</config>',
      );
      const stalling = path.join(directory, "stalling.svg");
      yield* fileSystem.writeFileString(stalling, `${"<?p?>".repeat(40)}<config><svg/></config>`);
      const unclosed = path.join(directory, "unclosed.svg");
      yield* fileSystem.writeFileString(unclosed, '<!DOCTYPE svg [<!ENTITY a "x><svg/>');
      // Roots named SVG or svgé are other elements.
      const upper = path.join(directory, "upper.svg");
      yield* fileSystem.writeFileString(upper, "<SVG/>API_KEY=abc123");
      const longer = path.join(directory, "longer.svg");
      yield* fileSystem.writeFileString(longer, "<svg\u00e9/>API_KEY=abc123");

      const error = yield* htmlRender
        .prepare(
          `<img src="${missing}"><img src='${folder}'><img src="C:\\nope\\shot.webp"><img src="${secret}"><img src="${report}"><img src="${config}"><img src="${stalling}"><img src="${unclosed}"><img src="${upper}"><img src="${longer}">`,
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(HtmlRender.HtmlRenderImagesNotFoundError);
      expect(error._tag === "HtmlRenderImagesNotFoundError" && error.paths).toEqual([
        missing,
        folder,
        "C:\\nope\\shot.webp",
        secret,
        report,
        config,
        stalling,
        unclosed,
        upper,
        longer,
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

  it.effect("removes the page when publishing is interrupted", () =>
    Effect.gen(function* () {
      const measuring = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const htmlRender = yield* HtmlRender.HtmlRender;
        const storedPages = fileSystem
          .readDirectory(config.attachmentsDir, { recursive: true })
          .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".html"))));

        const publishing = yield* htmlRender
          .publish({
            threadId: ThreadId.make("thread-html-cancel"),
            html: "<p>x</p>",
            title: "X",
            height: 200,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(measuring);
        expect(yield* storedPages).toHaveLength(1);
        yield* Fiber.interrupt(publishing);
        expect(yield* storedPages).toEqual([]);
      }).pipe(
        Effect.provide(
          htmlRenderLayer(
            undefined,
            Deferred.succeed(measuring, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
    }),
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
    "keeps every local file but the page itself out of the browser",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcessEnvironment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const htmlRender = yield* HtmlRender.HtmlRender;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-files-" });
          const secret = path.join(directory, "secret.js");
          yield* fileSystem.writeFileString(secret, 'window.secret = "abc123";');
          const secretUrl = NodeURL.pathToFileURL(secret).href;

          const preview = yield* htmlRender.preview({
            html: [
              `<script src="${secretUrl}"></script>`,
              `<iframe src="${secretUrl}" onload="console.log('frame loaded')"></iframe>`,
              '<script>addEventListener("load", () => console.log("secret:", window.secret ?? "none"));</script>',
            ].join(""),
          });

          const texts = preview.consoleMessages.map((message) => message.text);
          expect(texts).toContain("secret: none");
          expect(texts.join(" ")).not.toContain("abc123");
        }).pipe(Effect.scoped, Effect.provide(htmlRenderLayer(executable)));
      }),
    30_000,
  );

  it.live(
    "keeps the page off this machine's local network",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcessEnvironment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        // The page's connections go through a proxy that only reaches public
        // addresses, and WebRTC is gone. Each line below is a way out that
        // Chrome's own Local Network Access does not stop on its own.
        const requests: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.url} ${request.headers["sec-purpose"] ?? ""}`);
              response.end("<p>LOCAL</p>");
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) =>
            Effect.callback<void>((resume) => {
              listening.close(() => resume(Effect.void));
            }),
        );
        const datagrams: Array<string> = [];
        const udp = yield* Effect.acquireRelease(
          Effect.callback<NodeDgram.Socket>((resume) => {
            const socket = NodeDgram.createSocket("udp4");
            socket.on("message", (message) => datagrams.push(message.toString("hex")));
            socket.bind(0, "127.0.0.1", () => resume(Effect.succeed(socket)));
          }),
          (socket) =>
            Effect.callback<void>((resume) => {
              socket.close(() => resume(Effect.void));
            }),
        );
        const address = server.address();
        const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        const stun = `stun:127.0.0.1:${udp.address().port}`;
        yield* Effect.gen(function* () {
          const htmlRender = yield* HtmlRender.HtmlRender;
          yield* htmlRender.preview({
            html: [
              `<img src="${origin}/x.png"><iframe src="${origin}/"></iframe>`,
              `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${origin}/prefetch"]}]}</script>`,
              `<script>fetch("${origin}/").catch(() => {}); new WebSocket("ws${origin.slice(4)}/socket");`,
              `try { const peer = new RTCPeerConnection({ iceServers: [{ urls: "${stun}" }] });`,
              `peer.createDataChannel("x"); peer.createOffer().then((offer) => peer.setLocalDescription(offer));`,
              `} catch {}`,
              `window.open("${origin}/popup"); location.href = "${origin}/navigate";</script>`,
            ].join(""),
          });
        }).pipe(Effect.provide(htmlRenderLayer(executable)));
        expect(requests).toEqual([]);
        expect(datagrams).toEqual([]);
      }).pipe(Effect.scoped),
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
