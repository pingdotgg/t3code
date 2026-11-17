// @effect-diagnostics nodeBuiltinImport:off - Scans the checked-in tree with git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const ROOT = NodePath.resolve(import.meta.dirname, "..");

function trackedFiles(scanned: ReadonlyArray<string>, excluded: ReadonlyArray<RegExp>): string[] {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...scanned], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && !excluded.some((pattern) => pattern.test(file)))
    .filter((file) => NodeFS.existsSync(NodePath.join(ROOT, file)));
}

function readLines(file: string): string[] {
  return NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8").split("\n");
}

// Each of these installs upstream's server, which replaces the fork's on that machine.
const UPSTREAM_INSTALL =
  /t3\.codes\/install\.(?:sh|ps1)|\b(?:npx(?: --yes| -y)?|pnpm dlx|bunx) t3(?![\w-])/;

it("keeps upstream install commands out of user-facing fork code and docs", () => {
  const files = trackedFiles(
    ["apps", "packages", "scripts", "packaging", "docs/user"],
    [/\.test\.tsx?$/],
  );
  const hits = files.flatMap((file) =>
    readLines(file).flatMap((line, index) =>
      UPSTREAM_INSTALL.test(line) ? [`${file}:${index + 1}`] : [],
    ),
  );
  expect(hits).toEqual([]);
});

// The fork ships as Ada (packages/shared/src/branding.ts). Upstream syncs bring these back.
const UPSTREAM_BRAND = /T3 Code|T3 Agents|\bTheo\b|t3\.codes|pingdotgg/;
// Upstream product phrases ("T3 Connect", "T3 home") and `t3 <subcommand>` hints, which the names above miss.
const UPSTREAM_PHRASE = /\bT3 [A-Za-z]|(?<![\w./@$-])t3 (?:[a-z][\w-]*|--[a-z])/;

const BRAND_SCANNED = [
  "README.md",
  "docs/user",
  "apps/web/src",
  "apps/web/index.html",
  "apps/web/public/manifest.webmanifest",
  "apps/desktop/src",
  "apps/desktop/resources",
  "apps/desktop/gnome-extension",
  "apps/desktop/scripts/electron-launcher.mjs",
  "apps/desktop/package.json",
  "apps/mobile/src",
  "apps/mobile/app.config.ts",
  "apps/marketing/src",
  "apps/server/src",
  "packages",
  "scripts/build-desktop-artifact.ts",
  "scripts/install.sh",
  "scripts/install.ps1",
];

const BRAND_EXCLUDED = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.testkit\.ts$/,
  /\/test\//,
  /\/testkit\//,
  /\/fixtures?\//,
  /\.fixture\.ts$/,
];

type BrandAllowance = { file: RegExp; text?: string; why: string };

/**
 * What may keep an upstream name, and why. Everything else a user can see says Ada.
 * With `text`, only that substring is allowed: the rest of the line is still checked.
 */
const BRAND_ALLOWLIST: ReadonlyArray<BrandAllowance> = [
  {
    file: /^packages\/shared\/src\/branding\.ts$/,
    why: "Names the upstream app the fork installs beside, so copy about it can say so.",
  },
  // Functional endpoints the fork still uses. Renaming them would break the feature, not rebrand it.
  { file: /./, text: "t3.codes/schema/t3.json", why: "Published t3.json schema URL." },
  {
    file: /^(?:apps\/desktop\/resources\/linux\/com\.t3tools\.t3code\.metainfo\.xml|scripts\/build-desktop-artifact\.ts)$/,
    text: "T3 Tools",
    why: "Upstream's company, the copyright holder in LICENSE.",
  },
  // Identities other systems already know: providers, git history, peers, installed helpers.
  {
    file: /^(?:apps\/server\/src\/(?:provider\/(?:CodexProvider|CodexChatGptAuth|acp\/AntigravityAcpSupport)|mcp\/McpHttpServer)|packages\/provider-muse\/src\/server\/sdk)\.ts$/,
    text: "T3 Code",
    why: "Client name sent to providers.",
  },
  {
    file: /^(?:apps\/server\/src\/vcs\/GitVcsDriver|packages\/source-control-github\/src\/server\/githubStackRebase|packages\/provider-testing\/src\/replayWorkspace)\.ts$/,
    why: "Git author identity on commits the app makes.",
  },
  {
    file: /^apps\/server\/src\/peer\//,
    text: "T3 Code · ",
    why: "Peer session label prefix that other environments, upstream included, strip.",
  },
  {
    file: /^packages\/provider-opencode\/src\/server\/(?:OpenCodeServerLedger|v2\/adapter)\.ts$/,
    why: "Maintainer log lines.",
  },
  {
    file: /^apps\/server\/src\/mcp\/agents\/HeadlessGatewayHost\.ts$/,
    text: "Headless T3 Agents gateway",
    why: "Maintainer log lines.",
  },
  {
    file: /^apps\/desktop\/gnome-extension\/(?:metadata|bundle)\.json$/,
    text: "snap-shot@t3.codes",
    why: "UUID of the installed GNOME extension.",
  },
  {
    file: /^scripts\/build-desktop-artifact\.ts$/,
    text: "hello@t3.codes",
    why: "Deb maintainer email.",
  },
  // Legacy names that find or migrate existing installs, so updates land in place.
  {
    file: /^apps\/desktop\/src\/app\/(?:DesktopUserData|DesktopLegacyLocalStorage|WindowsSharedProfile)\.ts$/,
    why: "Legacy profile directories and the pre-rename profile owner.",
  },
  {
    file: /^apps\/desktop\/resources\/installer\.nsh$/,
    why: "Legacy exe names of a running app.",
  },
  {
    file: /^scripts\/build-desktop-artifact\.ts$/,
    text: '"T3 Agents"',
    why: "Pinned Windows exe name: taskbar pins, CLI shims and service units point at it.",
  },
  // Copy about the separate upstream product, which the fork installs beside.
  {
    file: /^apps\/desktop\/resources\/agents-installer\.nsh$/,
    text: "T3 Code",
    why: "Installer guards that protect T3 Code's folder.",
  },
  {
    file: /^packages\/source-control-github\/src\/shared\/definition\.ts$/,
    text: "T3 Code for GitHub",
    why: "Upstream's GitHub App name.",
  },
  {
    file: /^README\.md$/,
    text: "T3 Code",
    why: "Switching from T3 Code, which installs beside Ada.",
  },
  {
    file: /^docs\/user\/(?:install|updating)\.md$/,
    text: "T3 Code",
    why: "Warnings that T3 Code's installers replace Ada's server.",
  },
  {
    file: /^apps\/marketing\/src\/(?:lib\/seo\.ts|pages\/95\.astro)$/,
    text: "https://t3.codes",
    why: "Site origin, until the fork has its own domain.",
  },
  {
    file: /^apps\/desktop\/src\/app\/DesktopCliShim\.ts$/,
    text: "Written by T3 Code",
    why: "Launcher marker that older desktop builds look for to recognise their own launchers.",
  },
  {
    file: /^apps\/server\/src\/provider\/AgentInstructionFiles\.ts$/,
    text: "T3 managed instructions",
    why: "Marker in instruction files already written to users' projects.",
  },
  {
    file: /^packages\/mcp-gateway\/src\/skillImport\.ts$/,
    text: "T3 syncs this text",
    why: "Recognises a section older versions wrote into imported skills.",
  },
  {
    file: /^packages\/client-runtime\/src\/errors\/transport\.ts$/,
    text: "T3 server WebSocket",
    why: "Matches an error older servers send.",
  },
  // The `t3` command still exists beside `ada`, so copy that names it on purpose stays.
  ...["Another t3 ", "another t3", "t3 command", "t3 launcher", "t3 triage"].map((text) => ({
    file: /^apps\/(?:desktop\/src\/app\/(?:DesktopCliCommand|DesktopCliShim|DesktopApp)\.ts|web\/src\/(?:components\/settings\/CliCommandSettingsRow\.tsx|lib\/bootError\.ts))$/,
    text,
    why: "The desktop links `t3` and puts `ada` beside it as a best-effort alias, so these name the link it found or wrote.",
  })),
  {
    file: /^scripts\/install\.(?:sh|ps1)$/,
    text: "ada and t3",
    why: "The installer sets up both commands.",
  },
  {
    file: /^(?:packages\/shared\/src\/cliRelease\.ts|apps\/web\/src\/components\/sidebar\/updateEverything\.logic\.ts|docs\/user\/updating\.md)$/,
    text: "t3 update",
    why: "The copied update command runs on hosts older than `ada`.",
  },
  ...["t3 --version", "which -a t3", "older t3", "/t3 service install", "t3 service update"].map(
    (text) => ({
      file: /^apps\/server\/src\/service\/servicePreflight\.ts$/,
      text,
      why: "Diagnoses a stale `t3` from an npm or nvm install shadowing the installed one.",
    }),
  ),
  {
    file: /^apps\/server\/src\/cli\/uninstall\.ts$/,
    text: "This t3 runs",
    why: "Upstream's npm package, which this message says how to remove.",
  },
  {
    file: /^README\.md$/,
    text: "t3 service uninstall",
    why: "T3 Code's own command for its background service.",
  },
  {
    file: /^(?:README\.md|docs\/user\/remote-access\.md|apps\/(?:web|mobile)\/src\/(?:components|features\/connection)\/ConnectOnlyNoticeCoordinator\.tsx|apps\/(?:web|mobile)\/src\/connection\/storage\.ts|apps\/server\/src\/environment\/ConnectTeardown\.ts)$/,
    text: "T3 Connect",
    why: "The removed upstream service, named so the people who used it know what changed.",
  },
  {
    file: /^docs\/user\/outside-agents\.md$/,
    text: " t3 ",
    why: "The MCP server name readers give the agent; renaming it renames every tool they call.",
  },
  {
    file: /^docs\/user\/cursor\.md$/,
    text: "--filter t3",
    why: "The workspace package name.",
  },
];

/** Comment lines are for maintainers, not users. Markdown has no comments worth skipping. */
function isCommentLine(file: string, line: string): boolean {
  if (/\.mdx?$/.test(file)) return false;
  const code = line.trim();
  return (
    code.startsWith("//") ||
    code.startsWith("*") ||
    code.startsWith("/*") ||
    code.startsWith("<!--") ||
    (/\.(?:sh|ps1|nsh|ya?ml|py)$|(?:^|\/)[^.]+$/.test(file) && code.startsWith("#"))
  );
}

it("keeps upstream brand names out of user-facing fork code and docs", () => {
  const hits = trackedFiles(BRAND_SCANNED, BRAND_EXCLUDED).flatMap((file) =>
    readLines(file).flatMap((line, index) => {
      if (isCommentLine(file, line)) return [];
      let visible = line.replace(/\s\/\/\s.*$/, "");
      for (const entry of BRAND_ALLOWLIST) {
        if (!entry.file.test(file)) continue;
        if (entry.text === undefined) return [];
        visible = visible.replaceAll(entry.text, "");
      }
      return UPSTREAM_BRAND.test(visible) || UPSTREAM_PHRASE.test(visible)
        ? [`${file}:${index + 1}`]
        : [];
    }),
  );
  expect(hits).toEqual([]);
});
