// The real html_render handler against our MCP transport; no provider or browser process.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import * as Module from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { monorepo } from "../../../tools/monorepo.mjs";
import { sealedEnv } from "../../../tools/sealed-env.mjs";

export async function htmlParity(binary) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "conn-html-parity-"));
  try {
    const repo = monorepo();
    const require = Module.createRequire(Path.join(repo, "apps/server/package.json"));
    const pkg = (name) => import(pathToFileURL(require.resolve(name)).href);
    const src = (name) => import(pathToFileURL(Path.join(repo, "apps/server/src", name)).href);
    const Effect = await pkg("effect/Effect");
    const Layer = await pkg("effect/Layer");
    const Stream = await pkg("effect/Stream");
    const Option = await pkg("effect/Option");
    const NodeServices = await pkg("@effect/platform-node/NodeServices");
    const { HtmlRenderToolkit } = await src("mcp/toolkits/html/tools.ts");
    const HtmlHandlers = await src("mcp/toolkits/html/handlers.ts");
    const Access = await src("mcp/McpToolAccess.ts");
    const Invocation = await src("mcp/McpInvocationContext.ts");
    const { liveThreadShell } = await src("mcp/McpToolAccess.testkit.ts");
    const Threads = await src("orchestration-v2/ThreadManagementService.ts");
    const Config = await src("config.ts");
    const Html = await src("htmlRender/HtmlRender.ts");
    const Browser = await src("preview/PreviewBrowser.ts");
    const Sessions = await import(
      pathToFileURL(Path.join(repo, "packages/provider-core/src/server/McpProviderSessions.ts"))
        .href
    );
    const { htmlRenderFromToolItem } = await import(
      pathToFileURL(Path.join(repo, "packages/shared/src/toolOutput.ts")).href
    );
    const png = Path.join(root, "shot.png");
    const svg = Path.join(root, "image.svg");
    const invalid = Path.join(root, "secret.png");
    const missing = Path.join(root, "missing.jpg");
    FS.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    FS.writeFileSync(
      svg,
      '<?xml version="1.0"?><?xml-stylesheet href="x"?><!DOCTYPE svg [<!ENTITY fill "red">]><svg/>',
    );
    FS.writeFileSync(invalid, "secret=refuse");
    const page = Path.join(root, "source.HTML");
    FS.writeFileSync(
      page,
      '<!DOCTYPE HTML><html><head><meta charset="utf-8"></head><body>From disk</body></html>',
    );
    const badFile = Path.join(root, "not-html.html");
    FS.writeFileSync(badFile, "SECRET=refuse");
    const wrongExtension = Path.join(root, "source.txt");
    FS.writeFileSync(wrongExtension, "<html>wrong extension</html>");
    const hugeImage = Path.join(root, "big.png");
    FS.writeFileSync(hugeImage, Buffer.alloc(10 * 1024 * 1024 + 1));
    const hugePage = Path.join(root, "big.html");
    FS.writeFileSync(hugePage, Buffer.alloc(25 * 1024 * 1024 + 1));
    const repeatedImage = Path.join(root, "repeat.png");
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    bytes.write("\x89PNG", 0, "latin1");
    FS.writeFileSync(repeatedImage, bytes);
    const bomFile = Path.join(root, "bom.html");
    FS.writeFileSync(bomFile, "\ufeff<!doctype html><p>UTF-8 BOM</p>");
    const commented = Path.join(root, "commented.svg");
    FS.writeFileSync(commented, '<!DOCTYPE svg [<!-- ]> --><!ENTITY x "red">]><svg/>');
    const cases = [];
    const add = (args, extra = {}) =>
      cases.push({ args: { title: " Example ", height: 400, ...args }, ...extra });
    for (const html of [
      "<p>Hello</p>",
      "<!DOCTYPE html><html><body>Body</body></html>",
      '<html><head data-x=\">\"><title>Title</title></head></html>',
      "<!-- <head>wrong</head> --><p>real</p>",
      '<script>const x="<head>inert</head>";</script><head><title>real</title>',
      '<script>const x="</scripture><head>still inert</head>";</script><head>real',
      "<template><template><head>nested</head></template></template><head>real",
      "<template><head>unclosed",
      "<textarea><head>text</head></textarea><p>real</p>",
      "<plaintext><head>text",
      '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport"></head></html>',
      '<p>避免 100vh 😀</p><!-- <div style="height:100vh"> -->',
      '<style>main{width:100vw;height:320px}</style><img src="data:image/png;base64,AB1vh+2vh/3vhC">',
      `<img src="${png}"><div style="background:url(${svg})"></div><script>const shots=['${png}',\`${svg}\`];</script>`,
      '<img src="https://example.test/a.png"><img src="//cdn.example.test/a.png"><img src="./a.png">',
      `<img src='${invalid}'><img src="${missing}"><img src='${invalid}'>`,
      "<style>main{min-height:100vh}</style>",
      "<style media=screen>main{height:calc(100dvh - 2rem)}",
      "<div style='top:.5svh'>",
      "<div style=height:100vh>",
      `<img src="${hugeImage}">`,
      `<img src="${repeatedImage}">`.repeat(4),
      `<img src="${commented}">`,
    ])
      add({ html });
    add({ html: "<p>Small</p>", title: "  ", height: -500 });
    add({ html: "<p>Trim BOM</p>", title: "\ufeff  Title \ufeff" });
    add({ html: "<p>Tall</p>", height: 9999 }, { supervised: true });
    add({ path: bomFile });
    add({ path: page });
    add({ path: page }, { supervised: true });
    add({ path: badFile });
    add({ path: wrongExtension });
    add({ path: hugePage });
    add({ path: "relative.html" });
    add({ path: Path.join(root, "missing.html") });
    add({});
    add({ html: "<p>a</p>", path: page });
    const infrastructure = Layer.mergeAll(
      Config.layerTest(root, { prefix: "conn-html-ts-" }),
      Sessions.layer,
      Layer.succeed(Browser.PreviewBrowser, {
        installed: Effect.succeed(Option.none()),
        executable: Effect.die("html_render must not install Chrome"),
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const htmlLayer = Html.layer.pipe(Layer.provideMerge(infrastructure));
    const ts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* Config.ServerConfig;
          const answers = [];
          for (const c of cases) {
            const scope = {
              environmentId: "html-parity",
              requestNamespace: "html-parity",
              capabilities: new Set(["orchestration"]),
              thread: {
                threadId: "thread-html-parity",
                providerSessionId: "html-parity",
                providerInstanceId: "codex",
              },
            };
            const run = Effect.gen(function* () {
              const kit = yield* HtmlRenderToolkit.pipe(
                Effect.provide(Access.HandlersLayer.layer(HtmlHandlers.layerRender)),
              );
              const outputs = yield* kit
                .handle("html_render", c.args)
                .pipe(Stream.unwrap, Stream.runCollect);
              const last = outputs.at(-1);
              if (!last) throw new Error("no HTML result");
              const value = last.result;
              if (last.isFailure)
                return { failure: { _tag: value._tag, code: value.code, message: value.message } };
              const body = FS.readFileSync(
                Path.join(config.attachmentsDir, `${value.htmlRender.attachmentId}.html`),
                "utf8",
              );
              return { value, storedHtml: body };
            }).pipe(
              Effect.provideService(Invocation.McpInvocationContext, scope),
              Effect.provide(
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: (id) =>
                    Effect.succeed(
                      liveThreadShell(id, {
                        runtimeMode: c.supervised ? "approval-required" : "full-access",
                        interactionMode: "plan",
                      }),
                    ),
                }),
              ),
              Effect.match({
                onFailure: (e) => ({ failure: { _tag: e._tag, code: e.code, message: e.message } }),
                onSuccess: (x) => x,
              }),
            );
            answers.push(yield* run);
          }
          return answers;
        }).pipe(Effect.provide(htmlLayer)),
      ),
    );
    const state = Path.join(root, "rust-state");
    FS.mkdirSync(state);
    const result = spawnSync(binary, [state], {
      input: JSON.stringify(cases),
      encoding: "utf8",
      env: sealedEnv(Path.join(root, "rust-env")),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`HTML fixture failed: ${result.stderr}\n${result.stdout}`);
    console.log(result.stderr.trim());
    const rust = JSON.parse(result.stdout);
    let failed = 0;
    for (const [i, expected] of ts.entries()) {
      const reply = rust[i];
      const got = reply.result?.isError
        ? { failure: JSON.parse(reply.result.content[0].text) }
        : { value: reply.result?.structuredContent, storedHtml: reply.storedHtml };
      const normalize = (x) => {
        if (x.value?.htmlRender) x.value.htmlRender.attachmentId = "<id>";
        return x;
      };
      // Clients extract the same reference from the provider's dynamic tool output.
      const extracted =
        got.value === undefined ||
        htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_render", output: got.value }) !==
          undefined;
      const canonical = (x) =>
        JSON.stringify(x, (_, v) =>
          v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, v[k]]),
              )
            : v,
        );
      const equal = canonical(normalize(got)) === canonical(normalize(expected)) && extracted;
      console.log(
        `${equal ? "ok  " : "DIFF"} html_render handler ${i + 1}: ${JSON.stringify(cases[i]).slice(0, 100)}`,
      );
      if (!equal) {
        failed++;
        const describe = ({ storedHtml, ...rest }) => ({
          ...rest,
          storedBytes: storedHtml?.length,
        });
        let first = 0;
        while (
          expected.storedHtml?.[first] === got.storedHtml?.[first] &&
          first < (expected.storedHtml?.length ?? 0)
        )
          first++;
        console.error({
          expected: describe(expected),
          got: describe(got),
          extracted,
          first,
          ts: expected.storedHtml?.slice(first, first + 80),
          rust: got.storedHtml?.slice(first, first + 80),
        });
      }
    }
    if (failed) throw new Error(`${failed} HTML differences`);
    console.log(
      `html_render: ${cases.length} handler results and prepared attachments equal T3; no model or browser`,
    );
  } finally {
    FS.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await htmlParity(process.argv[2]);
