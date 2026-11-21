#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Host-side mobile accessibility audit CLI uses Node subprocess and filesystem APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import {
  renderBeforeAfterComparison,
  renderSingleAnnotatedImage,
} from "./mobile-audit/annotate.ts";
import {
  buildOverlayBoxes,
  diffAuditCaptures,
  findingTag,
  isPlatformNoise,
  renderMarkdownReport,
  resolveViewport,
  unitForPlatform,
  type AuditCapture,
  type AuditFinding,
  type AuditPlatform,
  type RawSnapshotData,
  type ScreenDiff,
} from "./mobile-audit/diff.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const DEFAULT_AGENT_DEVICE_ENTRY = NodePath.join(
  REPO_ROOT,
  "scripts/node_modules/agent-device/bin/agent-device.mjs",
);

function usage(): never {
  NodeProcess.stderr.write(`Usage:
  vp run mobile:audit capture --platform <ios|android> --screen <name> --out <dir> [--agent-device <bin>] [-- <agent-device-args...>]
  vp run mobile:audit compare --before <dir> --after <dir> --out <dir> [--before-label <text>] [--after-label <text>] [--all] [--fail-on-regression]
  vp run mobile:audit report --dir <dir> --out <dir>
`);
  NodeProcess.exit(2);
}

function parseFlags(argv: ReadonlyArray<string>) {
  const separator = argv.indexOf("--");
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const passThrough = separator >= 0 ? argv.slice(separator + 1) : [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < own.length; i++) {
    const token = own[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq >= 0) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      const next = own[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(token.slice(2), next);
        i += 1;
      } else {
        flags.set(token.slice(2), true);
      }
    }
  }
  return { flags, passThrough };
}

function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    NodeProcess.stderr.write(`Missing required flag: --${name}\n`);
    usage();
  }
  return value;
}

function execAgentDevice(bin: string | undefined, args: ReadonlyArray<string>): string {
  const file = bin ?? NodeProcess.execPath;
  const fullArgs = bin ? args : [DEFAULT_AGENT_DEVICE_ENTRY, ...args];
  return NodeChildProcess.execFileSync(file, fullArgs, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function parseJsonPayload<T>(raw: string, label: string): T {
  const parsed = JSON.parse(raw) as {
    readonly success?: boolean;
    readonly data?: T;
    readonly error?: { readonly message?: string; readonly hint?: string };
  };
  if (parsed.success === false) {
    throw new Error(
      `${label} failed: ${parsed.error?.message ?? "unknown error"}${parsed.error?.hint ? ` (${parsed.error.hint})` : ""}`,
    );
  }
  return (parsed.data ?? parsed) as T;
}

async function runCapture(argv: ReadonlyArray<string>) {
  const { flags, passThrough } = parseFlags(argv);
  const platformRaw = requiredString(flags, "platform");
  if (platformRaw !== "ios" && platformRaw !== "android") {
    throw new Error(`Invalid --platform "${platformRaw}" (expected ios or android).`);
  }
  const platform: AuditPlatform = platformRaw;
  const screen = requiredString(flags, "screen");
  const outRoot = NodePath.resolve(requiredString(flags, "out"));
  const agentDevice =
    typeof flags.get("agent-device") === "string"
      ? (flags.get("agent-device") as string)
      : undefined;

  const platformDir = NodePath.join(outRoot, platform);
  await NodeFSP.mkdir(platformDir, { recursive: true });

  const pngPath = NodePath.join(platformDir, `${screen}.png`);
  const screenshotArgs =
    platform === "ios"
      ? ["screenshot", "--pixel-density", "3", pngPath, ...passThrough]
      : ["screenshot", pngPath, ...passThrough];
  execAgentDevice(agentDevice, screenshotArgs);

  const auditRaw = execAgentDevice(agentDevice, ["audit", "--json", ...passThrough]);
  const auditData = parseJsonPayload<{
    readonly findings?: ReadonlyArray<AuditFinding>;
    readonly guidance?: Readonly<Record<string, string>>;
    readonly limitations?: ReadonlyArray<string>;
  }>(auditRaw, "agent-device audit");

  const snapRaw = execAgentDevice(agentDevice, ["snapshot", "--raw", "--json", ...passThrough]);
  const snapData = parseJsonPayload<RawSnapshotData>(snapRaw, "agent-device snapshot");

  const capture: AuditCapture = {
    platform,
    screen,
    viewport: resolveViewport({}, snapData),
    pixelDensity: platform === "android" ? (snapData.androidSnapshot?.pixelDensity ?? 1) : 1,
    findings: auditData.findings ?? [],
    guidance: auditData.guidance,
    limitations: auditData.limitations,
  };

  await NodeFSP.writeFile(NodePath.join(platformDir, `${screen}.raw.json`), snapRaw);
  await NodeFSP.writeFile(
    NodePath.join(platformDir, `${screen}.audit.json`),
    `${JSON.stringify(capture, null, 2)}\n`,
  );

  const unit = unitForPlatform(platform);
  NodeProcess.stdout.write(
    `[${platform}] ${screen}: ${capture.findings.length} finding(s) -> ${pngPath}\n`,
  );
  for (const finding of capture.findings) {
    NodeProcess.stdout.write(
      `  [${finding.kind}] ${finding.role} ${findingTag(finding, capture.pixelDensity, unit)} ${finding.label ? JSON.stringify(finding.label) : "(unnamed)"}\n`,
    );
  }
}

async function listCapturedScreens(
  rootDir: string,
): Promise<ReadonlyArray<{ readonly platform: AuditPlatform; readonly screen: string }>> {
  const results: Array<{ readonly platform: AuditPlatform; readonly screen: string }> = [];
  for (const platform of ["ios", "android"] as const) {
    const dir = NodePath.join(rootDir, platform);
    if (!NodeFS.existsSync(dir)) continue;
    const files = (await NodeFSP.readdir(dir)).filter((f) => f.endsWith(".audit.json")).sort();
    for (const file of files) {
      results.push({ platform, screen: file.replace(/\.audit\.json$/, "") });
    }
  }
  return results;
}

async function readCaptureSet(rootDir: string, platform: AuditPlatform, screen: string) {
  const base = NodePath.join(rootDir, platform, screen);
  const parsed = JSON.parse(
    await NodeFSP.readFile(`${base}.audit.json`, "utf8"),
  ) as Partial<AuditCapture>;
  const capture: AuditCapture = {
    platform: parsed.platform ?? platform,
    screen: parsed.screen ?? screen,
    viewport: parsed.viewport,
    pixelDensity: parsed.pixelDensity ?? 1,
    findings: parsed.findings ?? [],
    guidance: parsed.guidance,
    limitations: parsed.limitations,
  };
  const rawPath = `${base}.raw.json`;
  const raw = NodeFS.existsSync(rawPath)
    ? parseJsonPayload<RawSnapshotData>(await NodeFSP.readFile(rawPath, "utf8"), rawPath)
    : undefined;
  return {
    capture,
    raw,
    pngPath: `${base}.png`,
  };
}

async function runCompare(argv: ReadonlyArray<string>) {
  const { flags } = parseFlags(argv);
  const beforeDir = NodePath.resolve(requiredString(flags, "before"));
  const afterDir = NodePath.resolve(requiredString(flags, "after"));
  const outDir = NodePath.resolve(requiredString(flags, "out"));
  const beforeLabel =
    typeof flags.get("before-label") === "string"
      ? (flags.get("before-label") as string)
      : "BEFORE (base)";
  const afterLabel =
    typeof flags.get("after-label") === "string"
      ? (flags.get("after-label") as string)
      : "AFTER (head)";
  const renderAll = flags.get("all") === true;
  const failOnRegression = flags.get("fail-on-regression") === true;

  await NodeFSP.mkdir(outDir, { recursive: true });
  const beforeScreens = await listCapturedScreens(beforeDir);
  const afterScreens = await listCapturedScreens(afterDir);
  const afterSet = new Set(afterScreens.map((s) => `${s.platform}/${s.screen}`));
  const pairs = beforeScreens.filter((s) => afterSet.has(`${s.platform}/${s.screen}`));

  if (pairs.length === 0) {
    throw new Error(
      `No matching <platform>/<screen>.audit.json captures in both ${beforeDir} and ${afterDir}.`,
    );
  }

  const diffs: Array<ScreenDiff & { readonly imagePath?: string }> = [];
  for (const pair of pairs) {
    const before = await readCaptureSet(beforeDir, pair.platform, pair.screen);
    const after = await readCaptureSet(afterDir, pair.platform, pair.screen);
    const diff = diffAuditCaptures({
      before: before.capture,
      after: after.capture,
      beforeRaw: before.raw,
      afterRaw: after.raw,
    });

    const hasDelta = diff.fixed.length > 0 || diff.regressions.length > 0;
    let imagePath: string | undefined;
    if (
      (hasDelta || renderAll) &&
      NodeFS.existsSync(before.pngPath) &&
      NodeFS.existsSync(after.pngPath)
    ) {
      const { beforeBoxes, afterBoxes } = buildOverlayBoxes(
        diff,
        after.capture.pixelDensity || 1,
        before.capture.pixelDensity || 1,
      );
      const outPng = NodePath.join(outDir, `${pair.platform}-${pair.screen}.png`);
      await renderBeforeAfterComparison({
        beforePng: before.pngPath,
        beforeBoxes,
        beforeTitle: `${beforeLabel} · ${diff.beforeCount} finding(s)`,
        beforeViewport: resolveViewport(before.capture, before.raw),
        afterPng: after.pngPath,
        afterBoxes,
        afterTitle: `${afterLabel} · ${diff.afterCount} finding(s) (${diff.fixed.length} fixed, ${diff.regressions.length} new)`,
        afterBannerBg: diff.regressions.length > 0 ? "#b91c1c" : "#15803d",
        afterViewport: resolveViewport(after.capture, after.raw),
        outPath: outPng,
      });
      imagePath = outPng;
    }

    diffs.push({ ...diff, ...(imagePath ? { imagePath } : {}) });
  }

  const markdown = renderMarkdownReport(diffs);
  await NodeFSP.writeFile(
    NodePath.join(outDir, "diff.json"),
    `${JSON.stringify(diffs, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(outDir, "report.md"), markdown);
  NodeProcess.stdout.write(markdown);

  const totalRegressions = diffs.reduce((n, d) => n + d.regressions.length, 0);
  if (failOnRegression && totalRegressions > 0) {
    NodeProcess.exit(1);
  }
}

async function runReport(argv: ReadonlyArray<string>) {
  const { flags } = parseFlags(argv);
  const dir = NodePath.resolve(requiredString(flags, "dir"));
  const outDir = NodePath.resolve(requiredString(flags, "out"));
  await NodeFSP.mkdir(outDir, { recursive: true });

  const screens = await listCapturedScreens(dir);
  const lines: string[] = [
    "### Mobile accessibility audit report (`agent-device audit`)",
    "",
    "| Platform | Screen | Findings |",
    "| --- | --- | ---: |",
  ];

  for (const entry of screens) {
    const { capture, raw, pngPath } = await readCaptureSet(dir, entry.platform, entry.screen);
    const viewport = resolveViewport(capture, raw);
    const findings = capture.findings.filter(
      (f) => !isPlatformNoise(f, capture.platform, viewport),
    );
    lines.push(`| ${entry.platform} | \`${entry.screen}\` | ${findings.length} |`);

    if (findings.length > 0 && NodeFS.existsSync(pngPath)) {
      const unit = unitForPlatform(entry.platform);
      const boxes = findings
        .filter((f) => f.rect !== undefined)
        .map((f) => ({
          ...f.rect!,
          tag: findingTag(f, capture.pixelDensity || 1, unit),
          color: "#ef4444",
        }));
      const outPng = NodePath.join(outDir, `${entry.platform}-${entry.screen}.png`);
      await renderSingleAnnotatedImage({
        pngPath,
        boxes,
        bannerText: `${entry.platform} · ${entry.screen} · ${findings.length} finding(s)`,
        bannerBg: "#b91c1c",
        viewport,
        outPath: outPng,
      });
    }
  }

  const markdown = `${lines.join("\n")}\n`;
  await NodeFSP.writeFile(NodePath.join(outDir, "report.md"), markdown);
  NodeProcess.stdout.write(markdown);
}

const [subcommand, ...rest] = NodeProcess.argv.slice(2);
if (subcommand === "capture") {
  await runCapture(rest);
} else if (subcommand === "compare") {
  await runCompare(rest);
} else if (subcommand === "report") {
  await runReport(rest);
} else {
  usage();
}
