// @effect-diagnostics nodeBuiltinImport:off - plain local servers stand in for LAN services.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { HtmlRenderBrowserError } from "./headlessChrome.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

const layerHtmlRender = (
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
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-render-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const layerTest = layerHtmlRender();

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
      expect(prepared.indexOf("<head>")).toBeLessThan(prepared.indexOf('<style id="t3-theme">'));
      expect(prepared.indexOf('<style id="t3-theme">')).toBeLessThan(prepared.indexOf("<title>"));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects viewport height units, which make the fitted frame grow without end", () =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      for (const page of [
        "<style>main{min-height:100vh}</style>",
        "<style media=screen>main{height: calc(100dvh - 2rem)}",
        "<div style='top:.5svh'></div>",
        "<div style=height:100vh></div>",
      ]) {
        const error = yield* htmlRender.prepare(page).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HtmlRender.HtmlRenderViewportHeightError);
      }
      yield* htmlRender.prepare(
        '<style>main{width:100vw;height:320px}</style><img src="data:image/png;base64,AB1vh+2vh/3vhC">',
      );
      yield* htmlRender.prepare(
        "<p>Avoid 100vh here.</p><!-- <div style=\"height:100vh\"></div> --><script>const unit = '100vh';</script>",
      );
      yield* htmlRender.prepare(`<style>${"1".repeat(200_000)}vx</style>`);
    }).pipe(Effect.provide(layerTest)),
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
    }).pipe(Effect.provide(layerTest)),
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
      const secret = path.join(directory, "secret.png");
      yield* fileSystem.writeFileString(secret, "API_KEY=abc123");
      const report = path.join(directory, "report.svg");
      yield* fileSystem.writeFileString(report, "<!doctype html><body><svg></svg>API_KEY=abc123");
      const config = path.join(directory, "config.svg");
      yield* fileSystem.writeFileString(
        config,
        '<!DOCTYPE config [<!ENTITY a "a"><!ENTITY b "]><svg/>">]><config>API_KEY=abc123</config>',
      );
      const stalling = path.join(directory, "stalling.svg");
      yield* fileSystem.writeFileString(stalling, `${"<?p?>".repeat(40)}<config><svg/></config>`);
      const unclosed = path.join(directory, "unclosed.svg");
      yield* fileSystem.writeFileString(unclosed, '<!DOCTYPE svg [<!ENTITY a "x><svg/>');
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
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("publishes the prepared page as an html thread attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("thread-html-render");
      const session = {
        environmentId: EnvironmentId.make("html-render-environment"),
        threadId,
        providerSessionId: "first-credential",
        providerInstanceId: ProviderInstanceId.make("claude"),
        endpoint: "http://localhost:8311/mcp",
        authorizationHeader: "Bearer first-token",
        browserToolsAvailable: false,
      };
      yield* mcpSessions.set(session);

      const reference = yield* htmlRender.publish({
        threadId,
        html: `<p>Quarterly revenue</p>${" ".repeat(8_000)}`,
        title: "  Revenue  ",
        height: 9_000,
      });

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
      // Antigravity reports the call without its result, so the thread's
      // provider session keeps the page for one call with these arguments.
      const page = {
        html: `<p>Quarterly revenue</p>${" ".repeat(8_000)}`,
        title: "  Revenue  ",
        height: 9_000,
      };
      expect(
        yield* mcpSessions.takeHtmlRender(threadId, {
          ...page,
          html: page.html.replace("revenue", "expense"),
        }),
      ).toBe(undefined);
      expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toEqual(reference);
      expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toBe(undefined);
      const reused = yield* htmlRender.publish({ threadId, ...page });
      yield* mcpSessions.set({ ...session, browserToolsAvailable: true });
      expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toEqual(reused);

      yield* htmlRender.publish({ threadId, ...page });
      yield* mcpSessions.set({
        ...session,
        providerSessionId: "replacement-credential",
        providerInstanceId: ProviderInstanceId.make("antigravity"),
        authorizationHeader: "Bearer replacement-token",
      });
      const replacement = yield* htmlRender.publish({ threadId, ...page });
      expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toEqual(replacement);
      expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toBe(undefined);
      // Clearing the thread's MCP session drops the pages it kept.
      yield* htmlRender.publish({ threadId, ...page });
      yield* mcpSessions.clear(threadId);
      expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toBe(undefined);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("removes the page when publishing is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-html-cancel");
      const page = { html: "<p>x</p>", title: "X", height: 200 };
      const measuring = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const htmlRender = yield* HtmlRender.HtmlRender;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const storedPages = fileSystem
          .readDirectory(config.attachmentsDir, { recursive: true })
          .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".html"))));

        const publishing = yield* htmlRender.publish({ threadId, ...page }).pipe(Effect.forkChild);
        yield* Deferred.await(measuring);
        expect(yield* storedPages).toHaveLength(1);
        yield* Fiber.interrupt(publishing);
        expect(yield* storedPages).toEqual([]);
        expect(yield* mcpSessions.takeHtmlRender(threadId, page)).toBe(undefined);
      }).pipe(
        Effect.provide(
          layerHtmlRender(
            undefined,
            Deferred.succeed(measuring, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
    }),
  );

  it.effect("publishes a page by path exactly as the same HTML passed inline", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-page-" });
      const png = path.join(directory, "shot.png");
      yield* fileSystem.writeFile(png, PNG_BYTES);
      const html = `﻿<!-- report --><!DOCTYPE HTML><html><body><img src="${png}"></body></html>`;
      const file = path.join(directory, "report.html");
      yield* fileSystem.writeFileString(file, html);
      const threadId = ThreadId.make("thread-html-path");
      const stored = (reference: { readonly attachmentId: string }) =>
        fileSystem.readFileString(
          resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: reference.attachmentId,
          }) ?? "",
        );

      const inline = yield* htmlRender.publish({ threadId, html, title: "Shot", height: 300 });
      const byPath = yield* htmlRender.publish({
        threadId,
        path: file,
        title: "Shot",
        height: 300,
      });

      const page = yield* stored(byPath);
      expect(page).toBe(yield* stored(inline));
      expect(page).toContain(`data:image/png;base64,${Base64.encode(PNG_BYTES)}`);
      expect(page).toContain('<style id="t3-theme">');
      // A provider that drops the result finds the page by the arguments it sent.
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const call = { path: file, title: "Shot", height: 300 };
      expect(yield* mcpSessions.takeHtmlRender(threadId, call)).toEqual(byPath);
      expect(
        yield* mcpSessions.takeHtmlRender(threadId, { html, title: "Shot", height: 300 }),
      ).toEqual(inline);
      for (const start of ['<?xml version="1.0"?>\n<html>', "  <HEAD>", "<body>", "<html/>"]) {
        yield* fileSystem.writeFileString(file, `${start}<p>ok</p>`);
        yield* htmlRender.publish({ threadId, path: file, title: "Ok", height: 200 });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects page files that are not HTML, missing, or too large", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-page-" });
      const reason = (page: HtmlRender.HtmlRenderPage) =>
        htmlRender.preview(page).pipe(
          Effect.flip,
          Effect.map((error) => {
            expect(error).toBeInstanceOf(HtmlRender.HtmlRenderPageFileError);
            return error._tag === "HtmlRenderPageFileError" ? error.reason : error.message;
          }),
        );
      const write = (name: string, content: string | Uint8Array) => {
        const file = path.join(directory, name);
        return (
          typeof content === "string"
            ? fileSystem.writeFileString(file, content)
            : fileSystem.writeFile(file, content)
        ).pipe(Effect.as(file));
      };
      const notHtml = "it does not start with <!doctype html> or an <html>, <head> or <body> tag.";
      for (const [name, content] of [
        ["id_ed25519.html", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n"],
        ["env.html", "API_KEY=abc123\n<html></html>"],
        ["data.html", '{"html":"<html><body>API_KEY=abc123</body></html>"}'],
        ["hidden.html", "<!-- <html> -->API_KEY=abc123"],
        ["fragment.html", "<div><html></html></div>"],
        ["htmlx.html", "<htmlx>API_KEY=abc123"],
      ] as const) {
        expect(yield* reason({ path: yield* write(name, content) })).toBe(notHtml);
      }
      const binary = yield* write(
        "page.html",
        new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0xff]),
      );
      expect(yield* reason({ path: binary })).toBe("it is not UTF-8 text.");
      expect(yield* reason({ path: path.join(directory, "missing.html") })).toBe(
        "it does not exist or cannot be read.",
      );
      expect(yield* reason({ path: directory })).toBe("it is not a file.");
      expect(yield* reason({ path: "report.html" })).toBe("use an absolute path.");
      // Invalid UTF-8 past the byte bound proves stat rejects it before any read.
      const huge = yield* write("huge.html", new Uint8Array(512_000 * 3 + 4).fill(0xff));
      expect(yield* reason({ path: huge })).toBe(
        "it is 1.5 MiB; a page must be at most 512,000 characters.",
      );
      const long = yield* write("long.html", `<html>${"x".repeat(512_000)}`);
      expect(yield* reason({ path: long })).toBe(
        "it is 512,006 characters; a page must be at most 512,000 characters.",
      );
      // The schema leaves both optional and unbounded; the service applies one rule to both.
      for (const page of [
        {},
        { html: "" },
        { html: "<p>x</p>", path: long },
        { html: "x".repeat(512_001) },
      ]) {
        const error = yield* htmlRender.preview(page).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HtmlRender.HtmlRenderPageInputError);
        const published = yield* htmlRender
          .publish({
            threadId: ThreadId.make("thread-html-input"),
            ...page,
            title: "X",
            height: 200,
          })
          .pipe(Effect.flip);
        expect(published).toBeInstanceOf(HtmlRender.HtmlRenderPageInputError);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  // Windows reports ENOENT asynchronously for this path instead of throwing ENOTDIR.
  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "when the browser spawn throws synchronously",
    () => {
      it.live("reports a typed preview error", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = yield* fileSystem.makeTempFileScoped({ prefix: "t3-browser-spawn-" });
          const outcome = yield* HtmlRender.HtmlRender.use((htmlRender) =>
            htmlRender.preview({ html: "<p>x</p>" }).pipe(Effect.flip),
          ).pipe(
            Effect.provide(layerHtmlRender(path.join(file, "chrome-headless-shell"))),
            Effect.exit,
          );
          assert(Exit.isSuccess(outcome), "Expected a typed preview error.");
          const error = outcome.value;
          expect(error).toBeInstanceOf(HtmlRenderBrowserError);
          expect(error.message).toBe(
            "Headless Chrome could not render the page: the browser could not be started.",
          );
          expect(error).toMatchObject({ cause: { code: "ENOTDIR" } });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    },
  );

  // The fake browser is a shebang script, which Windows cannot execute.
  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "when the browser cannot be signalled",
    () => {
      // A browser T3 cannot signal, as under AppArmor in an LXC container, must still exit.
      it.live("asks the browser to close when the preview finishes instead of signalling it", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-fake-browser-",
          });
          const executable = path.join(directory, "chrome-headless-shell");
          const exitRecord = path.join(directory, "exited");
          yield* fileSystem.writeFileString(
            executable,
            `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGTERM", () => {});
const quit = () => { fs.writeFileSync(${JSON.stringify(exitRecord)}, "asked to close"); process.exit(0); };
const reply = (message) => fs.writeSync(4, JSON.stringify(message) + "\\0");
const results = {
  "Target.createTarget": { targetId: "page" },
  "Target.attachToTarget": { sessionId: "session" },
  "Runtime.evaluate": { result: { value: 100 } },
  "Page.captureScreenshot": { data: "iVBORw0KGgo=" },
};
let buffered = "";
fs.createReadStream(null, { fd: 3 }).on("end", quit).on("data", (chunk) => {
  const messages = (buffered + chunk).split("\\0");
  buffered = messages.pop();
  for (const { id, method, sessionId } of messages.map((raw) => JSON.parse(raw))) {
    if (method === "Browser.close") quit();
    reply({ id, sessionId, result: results[method] ?? {} });
    if (method === "Page.navigate") {
      const value = "x" + "\u{1F600}".repeat(300);
      const params = { type: "log", args: [{ type: "string", value }] };
      reply({ sessionId, method: "Runtime.consoleAPICalled", params });
      reply({ sessionId, method: "Page.loadEventFired", params: {} });
    }
  }
});
`,
            { mode: 0o755 },
          );

          const preview = yield* HtmlRender.HtmlRender.use((htmlRender) =>
            htmlRender.preview({ html: "<p>x</p>" }),
          ).pipe(Effect.provide(layerHtmlRender(executable)));
          const logged = preview.consoleMessages[0]?.text ?? "";
          expect(logged.isWellFormed()).toBe(true);
          expect(logged).toHaveLength(500);

          const exitedBy = yield* fileSystem.readFileString(exitRecord).pipe(Effect.option);
          expect(Option.getOrElse(exitedBy, () => "killed by a signal")).toBe("asked to close");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );

      it.live("names this server's home in the browser setup command", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-fake-browser-",
          });
          const executable = path.join(directory, "chrome-headless-shell");
          yield* fileSystem.writeFileString(
            executable,
            `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(PreviewBrowserHost.NO_SANDBOX_SIGNATURE)});\nprocess.exit(1);\n`,
            { mode: 0o755 },
          );

          const { error, baseDir } = yield* Effect.gen(function* () {
            const { baseDir } = yield* ServerConfig.ServerConfig;
            const htmlRender = yield* HtmlRender.HtmlRender;
            const error = yield* htmlRender.preview({ html: "<p>x</p>" }).pipe(Effect.flip);
            return { error, baseDir };
          }).pipe(
            Effect.provide(layerHtmlRender(executable)),
            Effect.provideService(HostProcess.UserId, 1000),
          );
          expect(error).toBeInstanceOf(PreviewBrowserHost.PreviewBrowserSandboxError);
          expect(error.message).toContain(`browser setup --base-dir ${baseDir}`);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    },
  );

  it.live("matches preview media queries and text colors to the requested appearance", (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
      if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
      yield* Effect.gen(function* () {
        const htmlRender = yield* HtmlRender.HtmlRender;
        for (const appearance of [undefined, "dark", "light"] as const) {
          const preview = yield* htmlRender.preview({
            appearance,
            html: [
              "<style>h1{color:#18181b}@media(prefers-color-scheme:dark){h1{color:#fafafa}}</style>",
              "<h1>The moon garden opens at dusk</h1>",
              '<script>console.log(matchMedia("(prefers-color-scheme:dark)").matches,',
              'getComputedStyle(document.querySelector("h1")).color);</script>',
            ].join(""),
          });
          expect(preview.consoleMessages).toContainEqual({
            level: "log",
            text: appearance === "light" ? "false rgb(24, 24, 27)" : "true rgb(250, 250, 250)",
          });
        }
      }).pipe(Effect.provide(layerHtmlRender(executable)));
    }),
  );

  it.live("previews a page by path exactly as the same HTML passed inline", (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
      if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const htmlRender = yield* HtmlRender.HtmlRender;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-page-" });
        const png = path.join(directory, "shot.png");
        yield* fileSystem.writeFile(png, PNG_BYTES);
        const html = `<!doctype html><h1>Moon garden</h1><img src="${png}" onload="console.log('image', this.naturalWidth)" onerror="console.log('no image')">`;
        const file = path.join(directory, "page.html");
        yield* fileSystem.writeFileString(file, html);

        const inline = yield* htmlRender.preview({ html });
        const byPath = yield* htmlRender.preview({ path: file });

        expect(byPath).toEqual(inline);
        // A missing image would be listed here.
        expect(byPath.missingImages).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layerHtmlRender(executable)));
    }),
  );

  it.live("keeps every local file but the page itself out of the browser", (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
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
      }).pipe(Effect.scoped, Effect.provide(layerHtmlRender(executable)));
    }),
  );

  it.live("keeps the page off this machine's local network", (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
      if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
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
      }).pipe(Effect.provide(layerHtmlRender(executable)));
      expect(requests).toEqual([]);
      expect(datagrams).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
