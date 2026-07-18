#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const DESIGN_GENERATION = 26;
const ICON_COMPOSER_EXECUTABLE_PARTS = [
  "Contents",
  "Applications",
  "Icon Composer.app",
  "Contents",
  "Executables",
  "ictool",
] as const;
const STANDALONE_ICON_COMPOSER_EXECUTABLE_PARTS = [
  "Icon Composer.app",
  "Contents",
  "Executables",
  "ictool",
] as const;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const IconComposerVersion = Schema.Struct({
  "bundle-version": Schema.NonEmptyString,
  "short-bundle-version": Schema.NonEmptyString,
});
const decodeIconComposerVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IconComposerVersion),
);

type IconPlatform = "iOS";

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

interface IconComposerTool {
  readonly path: string;
  readonly version: string;
  readonly bundleVersion: string;
  readonly supportsDesignGeneration: boolean;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class IconExportFileSystemError extends Schema.TaggedErrorClass<IconExportFileSystemError>()(
  "IconExportFileSystemError",
  {
    operation: Schema.Literals([
      "resolve-repository-root",
      "check-path",
      "read-directory",
      "read-file",
      "make-directory",
      "make-temp-directory",
      "make-temp-file",
      "write-file",
      "rename-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export file-system operation '${this.operation}' failed for ${this.path}.`;
  }
}

export class IconExportProcessError extends Schema.TaggedErrorClass<IconExportProcessError>()(
  "IconExportProcessError",
  {
    operation: Schema.Literals(["spawn", "collect-stdout", "collect-stderr", "wait-for-exit"]),
    command: Schema.String,
    argumentCount: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export process operation '${this.operation}' failed for ${this.command}.`;
  }
}

export class IconExportCommandFailedError extends Schema.TaggedErrorClass<IconExportCommandFailedError>()(
  "IconExportCommandFailedError",
  {
    command: Schema.String,
    argumentCount: NonNegativeInt,
    exitCode: Schema.Int,
    sourcePath: Schema.String,
    size: Schema.Int,
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Icon Composer failed to export ${this.sourcePath} at ${this.size}x${this.size}.`;
  }
}

export class IconExportToolResolutionError extends Schema.TaggedErrorClass<IconExportToolResolutionError>()(
  "IconExportToolResolutionError",
  {
    reason: Schema.Literals(["configured-invalid", "configured-outdated", "not-found"]),
    designGeneration: Schema.Int,
    toolPath: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "configured-invalid":
        return `ICON_COMPOSER_TOOL does not point to Icon Composer's export-capable ictool: ${this.toolPath}`;
      case "configured-outdated":
        return `ICON_COMPOSER_TOOL points to Icon Composer ${this.version}, but version 2 or newer is required for design generation ${this.designGeneration}.`;
      case "not-found":
        return `Could not find an Icon Composer 2.x exporter compatible with design generation ${this.designGeneration}. Install a compatible Icon Composer/Xcode or set ICON_COMPOSER_TOOL to Icon Composer.app/Contents/Executables/ictool.`;
    }
  }
}

export class IconExportSourceMissingError extends Schema.TaggedErrorClass<IconExportSourceMissingError>()(
  "IconExportSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing Icon Composer source project: ${this.sourcePath}`;
  }
}

export class IconExportRenditionError extends Schema.TaggedErrorClass<IconExportRenditionError>()(
  "IconExportRenditionError",
  {
    sourcePath: Schema.String,
    outputPath: Schema.String,
    expectedSize: Schema.Int,
    actualWidth: Schema.optional(Schema.Int),
    actualHeight: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const actual =
      this.actualWidth === undefined || this.actualHeight === undefined
        ? "an invalid PNG"
        : `${this.actualWidth}x${this.actualHeight}`;
    return `Icon Composer produced ${actual}; expected ${this.expectedSize}x${this.expectedSize} for ${this.sourcePath}.`;
  }
}

export class IconExportEncodingError extends Schema.TaggedErrorClass<IconExportEncodingError>()(
  "IconExportEncodingError",
  {
    variant: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode ICO renditions for the ${this.variant} icon.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedErrorClass<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
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

const MACOS_EXPORT_CODEX_PROMPT = [
  "Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.",
  "For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:",
  ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
  "Do not resize, composite, or otherwise post-process the exported PNGs.",
  "Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.",
];

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  Effect.mapError(
    (cause) =>
      new IconExportFileSystemError({
        operation: "resolve-repository-root",
        path: new URL("..", import.meta.url).pathname,
        cause,
      }),
  ),
);

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runCommand = Effect.fn("iconExport.runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args)).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportProcessError({
          operation: "spawn",
          command,
          argumentCount: args.length,
          cause,
        }),
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new IconExportProcessError({
              operation: "collect-stdout",
              command,
              argumentCount: args.length,
              cause,
            }),
        ),
      ),
      collectStreamAsString(child.stderr).pipe(
        Effect.mapError(
          (cause) =>
            new IconExportProcessError({
              operation: "collect-stderr",
              command,
              argumentCount: args.length,
              cause,
            }),
        ),
      ),
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(
          (cause) =>
            new IconExportProcessError({
              operation: "wait-for-exit",
              command,
              argumentCount: args.length,
              cause,
            }),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } satisfies CommandResult;
});

const iconComposerToolFromDeveloperDirectory = (developerDirectory: string, path: Path.Path) =>
  path.resolve(developerDirectory, "..", ...ICON_COMPOSER_EXECUTABLE_PARTS.slice(1));

const readSelectedDeveloperDirectory = Effect.fn("iconExport.readSelectedDeveloperDirectory")(
  function* () {
    const result = yield* runCommand("xcode-select", ["-p"]).pipe(Effect.option);
    return Option.flatMap(result, (output) => {
      const developerDirectory = output.stdout.trim();
      return output.exitCode === 0 && developerDirectory.length > 0
        ? Option.some(developerDirectory)
        : Option.none();
    });
  },
);

const findXcodeAppCandidates = Effect.fn("iconExport.findXcodeAppCandidates")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-directory",
          path: directory,
          cause,
        }),
    ),
    Effect.orElseSucceed(() => []),
  );
  return entries
    .filter((entry) => /^Xcode.*\.app$/.test(entry))
    .map((entry) => path.join(directory, entry, ...ICON_COMPOSER_EXECUTABLE_PARTS));
});

const probeIconComposerTool = Effect.fn("iconExport.probeIconComposerTool")(function* (
  candidate: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(candidate).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: candidate,
          cause,
        }),
    ),
    Effect.orElseSucceed(() => false),
  );
  if (!exists) return Option.none<IconComposerTool>();

  const result = yield* runCommand(candidate, ["--version"]).pipe(Effect.option);
  if (Option.isNone(result) || result.value.exitCode !== 0) {
    return Option.none<IconComposerTool>();
  }

  const version = yield* decodeIconComposerVersion(result.value.stdout).pipe(Effect.option);
  if (Option.isNone(version)) return Option.none<IconComposerTool>();

  const bundleVersion = version.value["bundle-version"];
  const shortVersion = version.value["short-bundle-version"];
  return Option.some({
    path: candidate,
    version: `${shortVersion} (${bundleVersion})`,
    bundleVersion,
    supportsDesignGeneration: Number.parseInt(shortVersion, 10) >= 2,
  });
});

const resolveIconComposerTool = Effect.fn("iconExport.resolveIconComposerTool")(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const configuredTool = environment.ICON_COMPOSER_TOOL?.trim();
  if (configuredTool) {
    const tool = yield* probeIconComposerTool(configuredTool);
    if (Option.isNone(tool)) {
      return yield* new IconExportToolResolutionError({
        reason: "configured-invalid",
        designGeneration: DESIGN_GENERATION,
        toolPath: configuredTool,
      });
    }
    if (!tool.value.supportsDesignGeneration) {
      return yield* new IconExportToolResolutionError({
        reason: "configured-outdated",
        designGeneration: DESIGN_GENERATION,
        toolPath: configuredTool,
        version: tool.value.version,
      });
    }
    return tool.value;
  }

  const selectedDeveloperDirectory = yield* readSelectedDeveloperDirectory();
  const configuredDeveloperDirectory = environment.DEVELOPER_DIR?.trim();
  const homeDirectory = environment.HOME?.trim();
  const searchDirectories = [
    "/Applications",
    ...(homeDirectory ? [path.join(homeDirectory, "Downloads")] : []),
  ];
  const xcodeCandidates = yield* Effect.forEach(searchDirectories, findXcodeAppCandidates, {
    concurrency: "unbounded",
  });
  const candidates = new Set<string>([
    ...(configuredDeveloperDirectory
      ? [iconComposerToolFromDeveloperDirectory(configuredDeveloperDirectory, path)]
      : []),
    ...Option.match(selectedDeveloperDirectory, {
      onNone: () => [],
      onSome: (developerDirectory) => [
        iconComposerToolFromDeveloperDirectory(developerDirectory, path),
      ],
    }),
    path.join("/Applications", ...STANDALONE_ICON_COMPOSER_EXECUTABLE_PARTS),
    ...(homeDirectory
      ? [path.join(homeDirectory, "Applications", ...STANDALONE_ICON_COMPOSER_EXECUTABLE_PARTS)]
      : []),
    ...xcodeCandidates.flat(),
  ]);
  const probed = yield* Effect.forEach([...candidates], probeIconComposerTool, {
    concurrency: "unbounded",
  });
  const compatibleTools = probed
    .filter(Option.isSome)
    .map((tool) => tool.value)
    .filter((tool) => tool.supportsDesignGeneration)
    .sort((left, right) =>
      right.bundleVersion.localeCompare(left.bundleVersion, undefined, { numeric: true }),
    );
  const newestTool = compatibleTools[0];
  if (newestTool) return newestTool;

  return yield* new IconExportToolResolutionError({
    reason: "not-found",
    designGeneration: DESIGN_GENERATION,
  });
});

const renderIcon = Effect.fn("iconExport.renderIcon")(function* (
  toolPath: string,
  sourcePath: string,
  outputPath: string,
  platform: IconPlatform,
  size: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const args = [
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
  ];
  const result = yield* runCommand(toolPath, args);
  if (result.exitCode !== 0) {
    return yield* new IconExportCommandFailedError({
      command: toolPath,
      argumentCount: args.length,
      exitCode: result.exitCode,
      sourcePath,
      size,
      ...(result.stdout.trim() ? { stdout: result.stdout.trim() } : {}),
      ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
    });
  }

  const contents = yield* fs.readFile(outputPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: outputPath,
          cause,
        }),
    ),
  );
  const buffer = Buffer.from(contents);
  const dimensions = yield* Effect.try({
    try: () => readPngDimensions(buffer),
    catch: (cause) =>
      new IconExportRenditionError({
        sourcePath,
        outputPath,
        expectedSize: size,
        cause,
      }),
  });
  if (dimensions.width !== size || dimensions.height !== size) {
    return yield* new IconExportRenditionError({
      sourcePath,
      outputPath,
      expectedSize: size,
      actualWidth: dimensions.width,
      actualHeight: dimensions.height,
    });
  }
  return buffer;
});

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  toolPath: string,
  repositoryRoot: string,
  temporaryDirectory: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(repositoryRoot, variant.source);
  const sourceExists = yield* fs.exists(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: sourcePath,
          cause,
        }),
    ),
  );
  if (!sourceExists) {
    return yield* new IconExportSourceMissingError({ sourcePath: variant.source });
  }

  const renditionCache = new Map<string, Buffer>();
  const render = Effect.fn("iconExport.renderVariant.rendition")(function* (
    platform: IconPlatform,
    size: number,
  ) {
    const cacheKey = `${platform}-${size}`;
    const cached = renditionCache.get(cacheKey);
    if (cached) return cached;

    const outputPath = path.join(temporaryDirectory, `${variant.label}-${platform}-${size}.png`);
    const contents = yield* renderIcon(toolPath, sourcePath, outputPath, platform, size);
    renditionCache.set(cacheKey, contents);
    return contents;
  });

  const ios = yield* render("iOS", 1024);
  const icoRenditions = yield* Effect.forEach(
    WINDOWS_ICON_SIZES,
    (size) => render("iOS", size).pipe(Effect.map((contents) => ({ size, contents }))),
    { concurrency: 1 },
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportEncodingError({ variant: variant.label, cause }),
  });

  return new Map<string, Buffer>([
    [variant.outputs.ios, ios],
    [variant.outputs.universal, ios],
    [variant.outputs.appleTouch, yield* render("iOS", 180)],
    [variant.outputs.favicon16, yield* render("iOS", 16)],
    [variant.outputs.favicon32, yield* render("iOS", 32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);
});

const logManualMacOsExportInstructions = Effect.fn("iconExport.logManualMacOsExportInstructions")(
  function* () {
    yield* Console.warn(
      [
        "macOS icons require Icon Composer's GUI-only pre-Tahoe preset and were not changed.",
        "Export each source with Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, Scale: 1×:",
        ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
        "See assets/README.md for the complete workflow.",
        "",
        "Copy/paste this prompt into Codex to perform the native exports:",
        "---",
        ...MACOS_EXPORT_CODEX_PROMPT,
        "---",
      ].join("\n"),
    );
  },
);

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "make-directory",
          path: targetDirectory,
          cause,
        }),
    ),
  );
  const temporaryPath = yield* fs
    .makeTempFileScoped({
      directory: targetDirectory,
      prefix: ".t3-icon-export-",
      suffix: ".tmp",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-file",
            path: targetDirectory,
            cause,
          }),
      ),
    );
  yield* fs.writeFile(temporaryPath, contents).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "write-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fs.rename(temporaryPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "rename-file",
          path: targetPath,
          cause,
        }),
    ),
  );
});

const isCurrent = Effect.fn("iconExport.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const exists = yield* fs.exists(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: targetPath,
          cause,
        }),
    ),
  );
  if (!exists) return false;

  const actual = yield* fs.readFile(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: targetPath,
          cause,
        }),
    ),
  );
  return Buffer.from(actual).equals(expected);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const repositoryRoot = yield* RepositoryRoot;
  const tool = yield* resolveIconComposerTool();
  const temporaryDirectory = yield* fs
    .makeTempDirectoryScoped({
      prefix: "t3-icon-export-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-directory",
            path: "system temporary directory",
            cause,
          }),
      ),
    );
  yield* Console.log(
    `Exporting icons with Icon Composer ${tool.version}, design generation ${DESIGN_GENERATION}.`,
  );

  const generated = new Map<string, Buffer>();
  for (const variant of ICON_VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} from ${variant.source}...`);
    const variantAssets = yield* renderVariant(
      tool.path,
      repositoryRoot,
      temporaryDirectory,
      variant,
    );
    for (const [relativePath, contents] of variantAssets) {
      generated.set(relativePath, contents);
    }
  }

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      return yield* Effect.die(
        new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, sourceContents);
  }

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: "unbounded" },
    );
    if (stale.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    yield* logManualMacOsExportInstructions();
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
  yield* logManualMacOsExportInstructions();
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Export development, preview, and production assets from Icon Composer projects.",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
