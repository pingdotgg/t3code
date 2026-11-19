// Browser pins, launch flags and browser-executed scripts follow T3 and its Playwright pin.
import * as FS from "node:fs";
import * as Path from "node:path";
import { createHash } from "node:crypto";
import * as Module from "node:module";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = Path.dirname(fileURLToPath(import.meta.url));
const root = Path.resolve(here, "../../../..");
const require = Module.createRequire(Path.join(root, "apps/server/package.json"));
const read = (p) => FS.readFileSync(Path.join(root, p), "utf8");
const browser = read("apps/server/src/preview/PreviewBrowser.ts");
const version = /const VERSION = "([^"]+)"/.exec(browser)?.[1];
const archives = Function(`return ${/const ARCHIVES = ([\s\S]*?) as const;/.exec(browser)?.[1]}`)();
if (!version || !archives.linux64) throw Error("Browser release shape changed");
const chromePlatform = Function(`return ${stripTypeScriptTypes(/const chromePlatform = ([\s\S]*?);\n\nexport interface/.exec(browser)?.[1])}`)();
const platforms = Object.fromEntries(
  [["linux", "linux"], ["macos", "darwin"], ["windows", "win32"]].flatMap(([os, nodeOS]) =>
    [["x86_64", "x64"], ["aarch64", "arm64"], ["x86", "ia32"]].flatMap(([arch, nodeArch]) => {
      const platform = chromePlatform(nodeOS, nodeArch);
      return platform ? [[`${os}-${arch}`, platform]] : [];
    }),
  ),
);
const bundlePath = Path.join(Path.dirname(require.resolve("playwright-core")), "lib/coreBundle.js");
const bundle = new Module.Module(bundlePath);
bundle.filename = bundlePath;
bundle.paths = Module.Module._nodeModulePaths(Path.dirname(bundlePath));
bundle._compile(
  FS.readFileSync(bundlePath, "utf8") +
    "\ninit_chromium(); module.exports.ConnChromium=Chromium; init_injectedScriptSource(); module.exports.ConnInjected=source3; init_input(); module.exports.ConnKeys=Object.fromEntries(usKeyboardLayout);",
  bundlePath,
);
const chromium = bundle.exports.ConnChromium;
const contexts = read("apps/server/src/preview/ServerBrowserContexts.ts");
// T3 names Chrome in the browser's own user agent (#38445); the spec keeps a placeholder and the
// per-platform value, and the launch fills it in (or drops the flag where T3 passes none).
const args = Function("userAgent", `return ${/args: (\[[\s\S]*?\]),/.exec(contexts)?.[1]}`)(
  "__USER_AGENT__",
);
const chromeUserAgent = Function(
  `${stripTypeScriptTypes(
    contexts.slice(
      contexts.indexOf("// Chrome froze its user agent"),
      contexts.indexOf("/** Change user agent and Sec-CH-UA together"),
    ),
    { mode: "strip" },
  )}\nreturn chromeUserAgent;`,
)();
const userAgents = Object.fromEntries(
  ["darwin", "linux", "win32"].flatMap((platform) => {
    const agent = chromeUserAgent({ version, platform });
    return agent ? [[platform, agent]] : [];
  }),
);
if (!args.includes("--user-agent=__USER_AGENT__") || !userAgents.darwin)
  throw Error("Browser user agent shape changed");
const tabArgs = (
  await chromium.prototype.defaultArgs.call(
    Object.create(chromium.prototype),
    { headless: true, chromiumSandbox: true, args },
    false,
    "__PROFILE__",
  )
).filter((x) => x !== "--enable-automation");
const persistentArgs = (
  await chromium.prototype.defaultArgs.call(
    Object.create(chromium.prototype),
    { headless: true, chromiumSandbox: true, args },
    true,
    "__PROFILE__",
  )
).filter((x) => x !== "--enable-automation");
const html = await import(pathToFileURL(Path.join(root, "packages/shared/src/htmlRender.ts")));
const palettes = await import(
  pathToFileURL(Path.join(root, "packages/shared/src/themePalettes.ts"))
);
const headless = read("apps/server/src/htmlRender/headlessChrome.ts");
const literal = (name) =>
  Function(
    `return ${new RegExp(`const ${name} =\\s*("(?:[^"\\\\]|\\\\.)*");`).exec(headless)?.[1]}`,
  )();
const host = read("apps/server/src/preview/PreviewBrowserHost.ts");
const rootError = /export class PreviewBrowserRootError[\s\S]*?return "([^"]*)";/.exec(host)?.[1];
const profiles = await import(
  pathToFileURL(Path.join(root, "packages/contracts/src/browserProfile.ts"))
);
const viewport = await import(
  pathToFileURL(Path.join(root, "packages/shared/src/previewViewport.ts"))
);
const pageSource = read("packages/shared/src/previewPage.ts");
const snapshotLiteral = /const SNAPSHOT_SCRIPT = (`(?:[^`\\]|\\.)*`);/.exec(pageSource)?.[1];
const dotted = /const DOTTED_SCRIPT = (`(?:[^`\\]|\\.)*`);/.exec(pageSource)?.[1];
const maskSource = pageSource.slice(
  pageSource.indexOf("const dottedPattern ="),
  pageSource.indexOf("/** Chromium sizes the capture"),
);
const dataSource =
  pageSource
    .slice(
      pageSource.indexOf("export const withoutDataPayload"),
      pageSource.indexOf("/**\n * Chromium's own console"),
    )
    .replace("export const", "const") +
  "\n" +
  pageSource.slice(
    pageSource.indexOf("const withoutTreeDataPayloads"),
    pageSource.indexOf("// The broker waits"),
  );
const mask = stripTypeScriptTypes(dataSource + "\n" + maskSource, { mode: "strip" });
const credential = await import(
  pathToFileURL(Path.join(root, "packages/shared/src/credentialFill.ts"))
);
const page = await import(pathToFileURL(Path.join(root, "packages/shared/src/previewPage.ts")));
const sourcePaths = [
  "apps/server/src/preview/ServerBrowser.ts",
  "apps/server/src/preview/Manager.ts",
  "apps/server/src/preview/PreviewBrowserHost.ts",
  "apps/server/src/htmlRender/headlessChrome.ts",
  "apps/server/src/htmlRender/HtmlRender.ts",
  "apps/server/src/htmlRender/publicProxy.ts",
  "packages/shared/src/previewPage.ts",
  "packages/shared/src/previewSessionControl.ts",
  "packages/shared/src/credentialFill.ts",
  "packages/contracts/src/browserProfile.ts",
  "packages/shared/src/previewViewport.ts",
  "packages/shared/src/preview.ts",
];
const upstreamDigest = createHash("sha256").update(sourcePaths.map(read).join("\n")).digest("hex");
const previewSource = read("packages/shared/src/preview.ts");
const nonWebSchemes = Function(
  `return ${/const KNOWN_NON_WEB_SCHEMES:[\s\S]*?= new Set\((\[[\s\S]*?\])\)/.exec(previewSource)?.[1]}`,
)();
const automation = await import(
  pathToFileURL(Path.join(root, "packages/contracts/src/previewAutomation.ts"))
);
const errorTemplates = {};
for (const selectorKind of ["locator", "selector", "focused-element"]) {
  const context = { operation: "<operation>", selectorKind, selectorLength: 987654 };
  if (selectorKind !== "focused-element")
    errorTemplates["invalid." + selectorKind] = Reflect.get(
      automation.PreviewAutomationInvalidSelectorError.prototype,
      "message",
      context,
    );
  errorTemplates["editable." + selectorKind] = Reflect.get(
    automation.PreviewAutomationTargetNotEditableError.prototype,
    "message",
    context,
  );
}
errorTemplates.stale = Reflect.get(
  automation.PreviewAutomationInvalidSelectorError.prototype,
  "message",
  { staleRef: true },
);
const serverSource = read("apps/server/src/preview/ServerBrowser.ts");
const editingSource = stripTypeScriptTypes(
  serverSource.slice(
    serverSource.indexOf("const editingCommand ="),
    serverSource.indexOf("const TITLE_LIMIT ="),
  ),
  { mode: "strip" },
).replace("const editingCommand =", "return ");
const editingCommand = Function(editingSource)();
const editingCommands = Object.fromEntries(
  Array.from({ length: 16 }, (_, modifiers) =>
    ["a", "c", "x", "z"].map((key) => [`${modifiers}:${key}`, editingCommand(key, modifiers)]),
  )
    .flat()
    .filter(([, command]) => command !== null),
);
const previewContract = await import(
  pathToFileURL(Path.join(root, "packages/contracts/src/preview.ts"))
);
const previewContractSource = read("packages/contracts/src/preview.ts");
const legacyPresetIds = Function(
  `return ${/const LEGACY_PREVIEW_VIEWPORT_PRESET_IDS = (\[[\s\S]*?\]) as const/.exec(previewContractSource)?.[1]}`,
)();
const constant = (source, name) => {
  const expression = new RegExp(`const ${name} = ([^;]+);`).exec(source)?.[1];
  if (!expression) throw Error(`Missing browser constant ${name}`);
  return Function(`return ${expression}`)();
};
const htmlArgsSource = /input\.executable,\s*(\[[\s\S]*?\]),\s*\{/.exec(headless)?.[1];
if (!htmlArgsSource) throw Error("HTML Chrome launch arguments changed");
const htmlArgs = (noSandbox) => Function("input", "proxy", `return ${htmlArgsSource}`)(
  { noSandbox, profileDirectory: "__PROFILE__" }, { port: "__PROXY_PORT__" },
);
const renderSource = read("apps/server/src/htmlRender/HtmlRender.ts");
const spec = {
  agentTabLimit: constant(serverSource, "AGENT_TAB_LIMIT"),
  serverTabLimit: constant(serverSource, "SERVER_TAB_LIMIT"),
  agentTabIdleMs: constant(serverSource, "AGENT_TAB_IDLE_MS"),
  viewportLimits: {
    minimum: previewContract.PREVIEW_VIEWPORT_MIN_DIMENSION,
    maximum: previewContract.PREVIEW_VIEWPORT_MAX_DIMENSION,
    area: previewContract.PREVIEW_VIEWPORT_MAX_AREA,
    presetIds: [...previewContract.PREVIEW_VIEWPORT_PRESET_IDS, ...legacyPresetIds],
  },
  editingCommands,
  errorTemplates,
  upstreamDigest,
  nonWebSchemes,
  keys: bundle.exports.ConnKeys,
  scripts: {
    snapshot: Function(`return ${snapshotLiteral}`)(),
    sensitive: credential.SENSITIVE_INPUT_VALUES_EXPRESSION,
    dotted: Function(`return ${dotted}`)(),
    mask,
    recorders: Object.fromEntries(
      [30, 60].map((rate) => [rate, page.recordingEncoderScript(rate)]),
    ),
  },
  profiles: profiles.BUILT_IN_BROWSER_PROFILES,
  presets: viewport.PREVIEW_VIEWPORT_PRESETS,
  version,
  archives,
  platforms,
  stagingStaleAfterMs: Function(`return ${/const STAGING_STALE_AFTER_MS = ([^;]+);/.exec(browser)?.[1]}`)(),
  screencastAckPaceMs: constant(serverSource, "SCREENCAST_ACK_PACE_MS"),
  tabArgs,
  persistentArgs,
  userAgents,
  html: {
    maxConcurrentBrowsers: constant(renderSource, "MAX_CONCURRENT_BROWSERS"),
    args: htmlArgs(false),
    unsandboxedArgs: htmlArgs(true),
    fakeIpTemplate: Function(
      "host",
      "address",
      `return ${/`DNS returned blocked[\s\S]*?`/.exec(headless)?.[0]}`,
    )("<host>", "<address>"),
    defaultWidth: html.HTML_RENDER_COLUMN_WIDTH,
    fragments: Object.fromEntries(
      ["dark", "light"].map((appearance) => [
        appearance,
        html.htmlRenderThemeFragment(
          html.htmlRenderTheme(
            appearance === "light"
              ? palettes.T3_CODE_LIGHT_THEME_COLORS
              : palettes.T3_CODE_DARK_THEME_COLORS,
            appearance,
            html.HTML_RENDER_MEASURE_FONTS,
          ),
        ),
      ]),
    ),
    settle: literal("SETTLE_EXPRESSION"),
    measure: literal("MEASURE_EXPRESSION"),
  },
  rootError,
};
const text = JSON.stringify(spec) + "\n";
const packageDir = Path.dirname(require.resolve("playwright-core"));
const license = FS.readFileSync(Path.join(packageDir, "LICENSE"), "utf8").replace(/\r\n/g,"\n");
const notice = FS.readFileSync(Path.join(packageDir, "NOTICE"), "utf8").replace(/\r\n/g,"\n");
const injected =
  `/* Generated from Playwright.\n${license}\n${notice}\n*/\n` + bundle.exports.ConnInjected;
const noticeTarget = Path.join(here, "NOTICE.playwright");
if (process.argv.includes("--check")) {
  if (FS.readFileSync(noticeTarget, "utf8") !== notice) throw Error("Playwright notice drift");
} else FS.writeFileSync(noticeTarget, notice);
const licenseTarget = Path.join(here, "LICENSE.playwright");
if (process.argv.includes("--check")) {
  if (FS.readFileSync(licenseTarget, "utf8") !== license) throw Error("Playwright license drift");
} else FS.writeFileSync(licenseTarget, license);
const injectedTarget = Path.join(here, "src/injected.js");
if (process.argv.includes("--check")) {
  if (FS.readFileSync(injectedTarget, "utf8") !== injected)
    throw Error("Playwright injected script drift");
} else FS.writeFileSync(injectedTarget, injected);
const target = Path.join(here, "src/spec.json");
if (process.argv.includes("--check")) {
  if (FS.readFileSync(target, "utf8") !== text)
    throw Error("Preview spec drift: run crates/conn-preview/gen-spec.mjs");
} else FS.writeFileSync(target, text);

const release = Function("chromePlatform", "VERSION", "ARCHIVES", `return ${stripTypeScriptTypes(/const previewBrowserRelease = ([\s\S]*?);\n\nconst megabytes/.exec(browser)?.[1])}`)(chromePlatform, version, archives);
const chromePin = JSON.stringify(release("linux", "x64"), null, 2) + "\n";
const pinTarget = Path.join(here, "chrome.json");
if (process.argv.includes("--check")) {
  if (FS.readFileSync(pinTarget, "utf8") !== chromePin) throw Error("Chrome release pin drift");
} else FS.writeFileSync(pinTarget, chromePin);
