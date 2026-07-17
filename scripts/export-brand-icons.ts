// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This macOS-only asset compiler shells out to Icon Composer and atomically updates tracked binary files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const DESIGN_GENERATION = 26;
const ICON_COMPOSER_EXECUTABLE = NodePath.join(
  "Contents",
  "Applications",
  "Icon Composer.app",
  "Contents",
  "Executables",
  "ictool",
);
const STANDALONE_ICON_COMPOSER_EXECUTABLE = NodePath.join(
  "Icon Composer.app",
  "Contents",
  "Executables",
  "ictool",
);

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

type IconPlatform = "iOS" | "macOS";

interface VariantOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
}

interface IconVariant {
  readonly label: string;
  readonly source: string;
  readonly outputs: VariantOutputs;
}

const ICON_VARIANTS = [
  {
    label: "development",
    source: BRAND_ASSET_PATHS.developmentIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "preview",
    source: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  },
  {
    label: "production",
    source: BRAND_ASSET_PATHS.productionIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const satisfies ReadonlyArray<IconVariant>;

function iconComposerToolFromDeveloperDirectory(developerDirectory: string): string {
  return NodePath.resolve(
    developerDirectory,
    "..",
    "Applications",
    "Icon Composer.app",
    "Contents",
    "Executables",
    "ictool",
  );
}

function readSelectedDeveloperDirectory(): string | null {
  const result = NodeChildProcess.spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findXcodeAppCandidates(directory: string): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Xcode.*\.app$/.test(entry.name))
      .map((entry) => NodePath.join(directory, entry.name, ICON_COMPOSER_EXECUTABLE));
  } catch {
    return [];
  }
}

interface IconComposerTool {
  readonly path: string;
  readonly version: string;
  readonly bundleVersion: string;
  readonly supportsDesignGeneration: boolean;
}

function probeIconComposerTool(candidate: string): IconComposerTool | null {
  if (!NodeFS.existsSync(candidate)) return null;

  const result = NodeChildProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;

  try {
    const version = JSON.parse(result.stdout) as {
      readonly "bundle-version"?: string;
      readonly "short-bundle-version"?: string;
    };
    const bundleVersion = version["bundle-version"];
    const shortVersion = version["short-bundle-version"];
    if (!bundleVersion || !shortVersion) return null;
    return {
      path: candidate,
      version: `${shortVersion} (${bundleVersion})`,
      bundleVersion,
      supportsDesignGeneration: Number.parseInt(shortVersion, 10) >= 2,
    };
  } catch {
    return null;
  }
}

function resolveIconComposerTool(): IconComposerTool {
  const configuredTool = process.env.ICON_COMPOSER_TOOL?.trim();
  if (configuredTool) {
    const tool = probeIconComposerTool(configuredTool);
    if (!tool) {
      throw new Error(
        `ICON_COMPOSER_TOOL does not point to Icon Composer's export-capable ictool: ${configuredTool}`,
      );
    }
    if (!tool.supportsDesignGeneration) {
      throw new Error(
        `ICON_COMPOSER_TOOL points to Icon Composer ${tool.version}, but version 2 or newer is required for design generation ${DESIGN_GENERATION}.`,
      );
    }
    return tool;
  }

  const selectedDeveloperDirectory = readSelectedDeveloperDirectory();
  const configuredDeveloperDirectory = process.env.DEVELOPER_DIR?.trim();
  const searchDirectories = ["/Applications", NodePath.join(NodeOS.homedir(), "Downloads")];
  const candidates = new Set<string>([
    ...(configuredDeveloperDirectory
      ? [iconComposerToolFromDeveloperDirectory(configuredDeveloperDirectory)]
      : []),
    ...(selectedDeveloperDirectory
      ? [iconComposerToolFromDeveloperDirectory(selectedDeveloperDirectory)]
      : []),
    NodePath.join("/Applications", STANDALONE_ICON_COMPOSER_EXECUTABLE),
    NodePath.join(NodeOS.homedir(), "Applications", STANDALONE_ICON_COMPOSER_EXECUTABLE),
    ...searchDirectories.flatMap(findXcodeAppCandidates),
  ]);

  const compatibleTools = [...candidates]
    .map(probeIconComposerTool)
    .filter((tool): tool is IconComposerTool => tool?.supportsDesignGeneration === true)
    .sort((left, right) =>
      right.bundleVersion.localeCompare(left.bundleVersion, undefined, { numeric: true }),
    );
  const newestTool = compatibleTools[0];
  if (newestTool) return newestTool;

  throw new Error(
    `Could not find an Icon Composer 2.x exporter compatible with design generation ${DESIGN_GENERATION}. Install a compatible Icon Composer/Xcode or set ICON_COMPOSER_TOOL to Icon Composer.app/Contents/Executables/ictool.`,
  );
}

function renderIcon(
  toolPath: string,
  sourcePath: string,
  outputPath: string,
  platform: IconPlatform,
  size: number,
): Buffer {
  const result = NodeChildProcess.spawnSync(
    toolPath,
    [
      sourcePath,
      "--export-image",
      "--output-file",
      outputPath,
      "--platform",
      platform,
      "--rendition",
      "Default",
      "--width",
      String(size),
      "--height",
      String(size),
      "--scale",
      "1",
      "--design-generation",
      String(DESIGN_GENERATION),
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Icon Composer failed to export ${sourcePath} at ${size}x${size}: ${details}`);
  }

  const contents = NodeFS.readFileSync(outputPath);
  const dimensions = readPngDimensions(contents);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(
      `Icon Composer exported ${dimensions.width}x${dimensions.height}; expected ${size}x${size} for ${sourcePath}.`,
    );
  }
  return contents;
}

function renderVariant(
  toolPath: string,
  temporaryDirectory: string,
  variant: IconVariant,
): ReadonlyMap<string, Buffer> {
  const sourcePath = NodePath.join(repoRoot, variant.source);
  if (!NodeFS.existsSync(sourcePath)) {
    throw new Error(`Missing Icon Composer source project: ${variant.source}`);
  }

  const renditionCache = new Map<string, Buffer>();
  const render = (platform: IconPlatform, size: number): Buffer => {
    const cacheKey = `${platform}-${size}`;
    const cached = renditionCache.get(cacheKey);
    if (cached) return cached;

    const outputPath = NodePath.join(
      temporaryDirectory,
      `${variant.label}-${platform}-${size}.png`,
    );
    const contents = renderIcon(toolPath, sourcePath, outputPath, platform, size);
    renditionCache.set(cacheKey, contents);
    return contents;
  };

  const ios = render("iOS", 1024);
  const macos = render("macOS", 1024);
  const ico = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: render("iOS", size) })),
  );

  return new Map<string, Buffer>([
    [variant.outputs.ios, ios],
    [variant.outputs.macos, macos],
    [variant.outputs.universal, ios],
    [variant.outputs.appleTouch, render("iOS", 180)],
    [variant.outputs.favicon16, render("iOS", 16)],
    [variant.outputs.favicon32, render("iOS", 32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);
}

function writeAtomically(relativePath: string, contents: Buffer): void {
  const targetPath = NodePath.join(repoRoot, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  NodeFS.writeFileSync(temporaryPath, contents);
  NodeFS.renameSync(temporaryPath, targetPath);
}

function isCurrent(relativePath: string, expected: Buffer): boolean {
  const targetPath = NodePath.join(repoRoot, relativePath);
  return NodeFS.existsSync(targetPath) && NodeFS.readFileSync(targetPath).equals(expected);
}

function main(): void {
  const args = process.argv.slice(2);
  const checkOnly = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !checkOnly) {
    throw new Error("Usage: node scripts/export-brand-icons.ts [--check]");
  }

  const tool = resolveIconComposerTool();
  const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-icon-export-"));
  console.log(
    `Exporting icons with Icon Composer ${tool.version}, design generation ${DESIGN_GENERATION}.`,
  );

  try {
    const generated = new Map<string, Buffer>();
    for (const variant of ICON_VARIANTS) {
      console.log(`Rendering ${variant.label} from ${variant.source}...`);
      for (const [relativePath, contents] of renderVariant(
        tool.path,
        temporaryDirectory,
        variant,
      )) {
        generated.set(relativePath, contents);
      }
    }

    if (checkOnly) {
      const stale = [...generated.entries()]
        .filter(([relativePath, contents]) => !isCurrent(relativePath, contents))
        .map(([relativePath]) => relativePath);
      if (stale.length > 0) {
        throw new Error(
          `Generated icon assets are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`,
        );
      }
      console.log(`All ${generated.size} generated icon assets are current.`);
      return;
    }

    for (const [relativePath, contents] of generated) {
      writeAtomically(relativePath, contents);
    }
    console.log(`Updated ${generated.size} generated icon assets.`);
  } finally {
    NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
