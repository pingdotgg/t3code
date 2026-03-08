import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export interface CompiledMacIconAsset {
  readonly assetCatalog: Buffer;
  readonly icnsFile: Buffer;
}

function parseActoolVersion(rawOutput: string): string | null {
  const match = rawOutput.match(
    /<key>short-bundle-version<\/key>\s*<string>([^<]+)<\/string>/,
  );
  return match?.[1] ?? null;
}

function assertSupportedActoolVersion(): void {
  const result = spawnSync("actool", ["--version"], {
    encoding: "utf8",
  });
  const version = parseActoolVersion(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  const major = Number(version?.split(".")[0] ?? Number.NaN);

  if (result.status !== 0 || !version || !Number.isFinite(major)) {
    throw new Error(
      "Failed to read actool version. Install Xcode 26 or newer to enable macOS appearance-aware icons.",
    );
  }

  if (major < 26) {
    throw new Error(
      `Unsupported actool version ${version}. Install Xcode 26 or newer to enable macOS appearance-aware icons.`,
    );
  }
}

export async function generateAssetCatalogForIcon(
  inputPath: string,
): Promise<CompiledMacIconAsset> {
  assertSupportedActoolVersion();

  const tempRoot = await mkdtemp(resolve(tmpdir(), "t3code-icon-composer-"));
  const iconPath = resolve(tempRoot, "Icon.icon");
  const outputPath = resolve(tempRoot, "out");

  try {
    await cp(inputPath, iconPath, { recursive: true });
    await mkdir(outputPath, { recursive: true });

    const result = spawnSync(
      "actool",
      [
        iconPath,
        "--compile",
        outputPath,
        "--output-format",
        "human-readable-text",
        "--notices",
        "--warnings",
        "--output-partial-info-plist",
        resolve(outputPath, "assetcatalog_generated_info.plist"),
        "--app-icon",
        "Icon",
        "--include-all-app-icons",
        "--accent-color",
        "AccentColor",
        "--enable-on-demand-resources",
        "NO",
        "--development-region",
        "en",
        "--target-device",
        "mac",
        "--minimum-deployment-target",
        "26.0",
        "--platform",
        "macosx",
      ],
      {
        encoding: "utf8",
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `actool failed while compiling '${inputPath}': ${(result.stderr || result.stdout || "").trim()}`,
      );
    }

    return {
      assetCatalog: await readFile(resolve(outputPath, "Assets.car")),
      icnsFile: await readFile(resolve(outputPath, "Icon.icns")),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
