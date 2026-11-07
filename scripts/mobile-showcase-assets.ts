// @effect-diagnostics nodeBuiltinImport:off - Host-side Pen CLI and image export automation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import showcaseConfig, { type ShowcaseAppearance } from "./mobile-showcase.config.ts";
import {
  normalizeStorePng,
  parseShowcaseCliArgs,
  planShowcaseCaptures,
  validateStoreAsset,
} from "./mobile-showcase.ts";

const TEMPLATE_DIRECTORY = NodeURL.fileURLToPath(
  new URL("./mobile-showcase-assets/", import.meta.url),
);
const ASSETS_DIRECTORY = "T3 Code AppStore Assets-assets";
export const PEN_LAYOUTS = {
  dark: ["VzYVc", "HTuJU", "aJlvZ", "xEv0b", "Fv2DI", "cPgee", "Uv0Se"],
  light: ["vLscN", "jvvlj", "E9ELUC", "R4sQ6I", "eYCoY", "E3y7Q", "mivY7"],
} as const;
export const PEN_SCENES = [
  ["01-sessions", "threads"],
  ["02-environments", "environments"],
  ["03-chat", "thread"],
  ["04-terminal", "terminal"],
  ["05-diff", "review"],
  ["06-live-activity", "agent-activity"],
] as const;

export function penScreenshotFilename(asset: string, appearance: ShowcaseAppearance): string {
  return `${asset}-${appearance}${asset === "06-live-activity" ? "-v2" : "@hi2"}.png`;
}

export async function preparePenAssets(
  inputDirectory: string,
  temporaryDirectory: string,
  appearance: ShowcaseAppearance,
): Promise<void> {
  const device = showcaseConfig.devices.find((candidate) => candidate.id === "iphone-6.9")!;
  await NodeFSP.cp(TEMPLATE_DIRECTORY, temporaryDirectory, { recursive: true });
  for (const [asset, scene] of PEN_SCENES) {
    const bytes = await NodeFSP.readFile(NodePath.join(inputDirectory, `${scene}.png`));
    validateStoreAsset(device.storeAsset, bytes, `${appearance}/${scene}`);
    await NodeFSP.writeFile(
      NodePath.join(temporaryDirectory, ASSETS_DIRECTORY, penScreenshotFilename(asset, appearance)),
      bytes,
    );
  }
}

export async function renderPenAssets(
  inputDirectory: string,
  outputDirectory: string,
  appearance: ShowcaseAppearance,
): Promise<void> {
  if (!NodeProcess.env.PEN_CLI_KEY) {
    throw new Error("Set PEN_CLI_KEY before exporting the Pen App Store layouts.");
  }
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-pen-assets-"),
  );
  try {
    await preparePenAssets(inputDirectory, temporaryDirectory, appearance);
    const exportDirectory = NodePath.join(temporaryDirectory, "exports");
    const command = `execute(${JSON.stringify({
      input: `Export(${JSON.stringify(PEN_LAYOUTS[appearance])}, "png", ${JSON.stringify(exportDirectory)}, {scale: 1})`,
    })})\nexit()\n`;
    const result = NodeChildProcess.spawnSync(
      "pen",
      [
        "interactive",
        "--in",
        NodePath.join(temporaryDirectory, "app-store.pen"),
        "--out",
        NodePath.join(temporaryDirectory, "render.pen"),
      ],
      { input: command, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (
      result.error ||
      result.status !== 0 ||
      /\b(error|failed)\b/iu.test(result.stdout + result.stderr)
    ) {
      const detail =
        `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`.replaceAll(
          NodeProcess.env.PEN_CLI_KEY,
          "[REDACTED]",
        );
      throw new Error(`Pen export failed: ${detail}`);
    }
    const images = await Promise.all(
      PEN_LAYOUTS[appearance].map(async (id, index) => {
        const bytes = normalizeStorePng(
          await NodeFSP.readFile(NodePath.join(exportDirectory, `${id}.png`)),
        );
        validateStoreAsset(
          {
            store: "apple",
            directory: outputDirectory,
            width: 1290,
            height: 2796,
            minimumUploadCount: 7,
            maximumUploadCount: 7,
          },
          bytes,
          id,
        );
        return { filename: `${PEN_SCENES[index]?.[0] ?? "07-testimonials"}.png`, bytes };
      }),
    );
    await NodeFSP.mkdir(outputDirectory, { recursive: true });
    for (const image of images) {
      await NodeFSP.writeFile(NodePath.join(outputDirectory, image.filename), image.bytes);
    }
    NodeProcess.stdout.write(`Exported 7 ${appearance} Pen layouts to ${outputDirectory}\n`);
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      input: { type: "string", default: "artifacts/app-store/screenshots/apple/iphone-6.9" },
      output: { type: "string", default: "artifacts/app-store/pen" },
      appearance: { type: "string", default: "both" },
      theme: { type: "string", default: "t3-code" },
    },
  });
  const options = parseShowcaseCliArgs([
    "--device",
    "iphone-6.9",
    "--appearance",
    values.appearance,
    "--theme",
    values.theme,
  ]);
  for (const capture of planShowcaseCaptures(showcaseConfig, options)) {
    await renderPenAssets(
      NodePath.resolve(values.input, capture.appearance, capture.theme),
      NodePath.resolve(values.output, capture.appearance, capture.theme),
      capture.appearance,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    NodeProcess.exit(1);
  });
}
