import type { EnvironmentApi, ProjectEntry, ProjectFileVersion } from "@forma/contracts";

const VITE_CONFIG_BASENAME_PATTERN = /^vite\.config\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;
const PACKAGE_JSON_BASENAME = "package.json";
const ROOT_LOCKFILE_CANDIDATES = ["bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const GRAPH_INCLUDE_GLOB = "src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,css,scss,sass,less}";
const GRAPH_EXCLUDE_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/*.stories.*", "**/*.story.*"];
const COMPONENT_INCLUDE_GLOB = "src/**/*.{tsx,jsx}";
const LEGACY_PREVIEW_INCLUDE_GLOB = "src/**/*.preview.tsx";
const PREVIEW_VITE_DEPENDENCY = "@forma/preview-react-vite";
const REACT_VITE_PLUGIN_DEPENDENCY = "@vitejs/plugin-react";

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

interface PackageJsonShape {
  readonly packageManager?: string | undefined;
  readonly scripts?: Record<string, string> | undefined;
  readonly dependencies?: Record<string, string> | undefined;
  readonly devDependencies?: Record<string, string> | undefined;
}

interface ProjectTextFile {
  readonly relativePath: string;
  readonly contents: string;
  readonly version: ProjectFileVersion;
}

export interface PreviewSetupWrite {
  readonly relativePath: string;
  readonly contents: string;
  readonly expectedVersion: ProjectFileVersion | null;
}

export interface PreviewSetupScaffold {
  readonly appRoot: string;
  readonly launchCwd: string;
  readonly command: readonly [string, ...string[]];
  readonly writes: readonly PreviewSetupWrite[];
  readonly notes: readonly string[];
  readonly viteConfigPath: string | null;
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function pathDepth(relativePath: string): number {
  return normalizePath(relativePath)
    .split("/")
    .filter((segment) => segment.length > 0).length;
}

function dirname(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  const lastSeparatorIndex = normalized.lastIndexOf("/");
  if (lastSeparatorIndex === -1) {
    return ".";
  }
  return normalized.slice(0, lastSeparatorIndex);
}

function basename(relativePath: string): string {
  return normalizePath(relativePath).split("/").at(-1) ?? relativePath;
}

function joinRelativePath(parent: string, child: string): string {
  if (parent === "." || parent.length === 0) {
    return normalizePath(child);
  }
  return normalizePath(`${parent}/${child}`);
}

function relativeImportPath(fromDir: string, targetPath: string): string {
  const fromSegments = (fromDir === "." ? "" : normalizePath(fromDir)).split("/").filter(Boolean);
  const targetSegments = normalizePath(targetPath).split("/").filter(Boolean);
  let index = 0;
  while (
    index < fromSegments.length &&
    index < targetSegments.length &&
    fromSegments[index] === targetSegments[index]
  ) {
    index += 1;
  }
  const upSegments = fromSegments.slice(index).map(() => "..");
  const downSegments = targetSegments.slice(index);
  const combined = [...upSegments, ...downSegments].join("/");
  return combined.startsWith(".") ? combined : `./${combined}`;
}

function formatStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function packageManagerCommand(packageManager: PackageManager): readonly [string, ...string[]] {
  switch (packageManager) {
    case "bun":
      return ["bun", "run", "dev"];
    case "pnpm":
      return ["pnpm", "run", "dev"];
    case "yarn":
      return ["yarn", "run", "dev"];
    default:
      return ["npm", "run", "dev"];
  }
}

function parsePackageManager(packageManagerValue: string | undefined): PackageManager | null {
  if (!packageManagerValue) {
    return null;
  }
  const normalized = packageManagerValue.trim().toLowerCase();
  if (normalized.startsWith("bun@")) {
    return "bun";
  }
  if (normalized.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (normalized.startsWith("yarn@")) {
    return "yarn";
  }
  if (normalized.startsWith("npm@")) {
    return "npm";
  }
  return null;
}

function parsePackageJson(contents: string): PackageJsonShape | null {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as PackageJsonShape;
  } catch {
    return null;
  }
}

function hasDependency(packageJson: PackageJsonShape | null, dependencyName: string): boolean {
  if (!packageJson) {
    return false;
  }
  return Boolean(
    packageJson.dependencies?.[dependencyName] ?? packageJson.devDependencies?.[dependencyName],
  );
}

function hasDevScript(packageJson: PackageJsonShape | null): boolean {
  const scripts = packageJson?.scripts;
  return !!scripts && typeof scripts.dev === "string" && scripts.dev.trim().length > 0;
}

function usesVite(packageJson: PackageJsonShape | null): boolean {
  if (!packageJson) {
    return false;
  }
  if (hasDependency(packageJson, "vite")) {
    return true;
  }
  return packageJson.scripts?.dev?.includes("vite") ?? false;
}

function usesReact(packageJson: PackageJsonShape | null): boolean {
  if (!packageJson) {
    return false;
  }
  return hasDependency(packageJson, "react");
}

function isViteConfigEntry(entry: ProjectEntry): boolean {
  return entry.kind === "file" && VITE_CONFIG_BASENAME_PATTERN.test(basename(entry.path));
}

function isPackageJsonEntry(entry: ProjectEntry): boolean {
  return entry.kind === "file" && basename(entry.path) === PACKAGE_JSON_BASENAME;
}

function selectPreferredViteConfigPath(entries: ReadonlyArray<ProjectEntry>): string | null {
  const candidates = entries.filter(isViteConfigEntry).map((entry) => normalizePath(entry.path));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.toSorted((left, right) => {
    const depthDifference = pathDepth(left) - pathDepth(right);
    if (depthDifference !== 0) {
      return depthDifference;
    }
    return left.localeCompare(right);
  })[0]!;
}

function selectPreferredAppPackage(input: {
  readonly packageFiles: ReadonlyArray<ProjectTextFile>;
}): ProjectTextFile | null {
  const rankedCandidates = input.packageFiles
    .map((file) => ({
      file,
      parsed: parsePackageJson(file.contents),
    }))
    .filter((entry) => {
      if (!entry.parsed) {
        return false;
      }
      return usesVite(entry.parsed) || usesReact(entry.parsed) || hasDevScript(entry.parsed);
    })
    .toSorted((left, right) => {
      const leftScore =
        (usesVite(left.parsed) ? 100 : 0) +
        (usesReact(left.parsed) ? 10 : 0) +
        (hasDevScript(left.parsed) ? 1 : 0);
      const rightScore =
        (usesVite(right.parsed) ? 100 : 0) +
        (usesReact(right.parsed) ? 10 : 0) +
        (hasDevScript(right.parsed) ? 1 : 0);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      const depthDifference =
        pathDepth(left.file.relativePath) - pathDepth(right.file.relativePath);
      if (depthDifference !== 0) {
        return depthDifference;
      }
      return left.file.relativePath.localeCompare(right.file.relativePath);
    });

  return rankedCandidates[0]?.file ?? null;
}

async function searchEntriesSafe(input: {
  readonly api: EnvironmentApi;
  readonly cwd: string;
  readonly query: string;
  readonly limit?: number | undefined;
}): Promise<ReadonlyArray<ProjectEntry>> {
  try {
    const result = await input.api.projects.searchEntries({
      cwd: input.cwd,
      query: input.query,
      limit: input.limit ?? 50,
    });
    return result.entries;
  } catch {
    return [];
  }
}

async function readProjectFileIfExists(input: {
  readonly api: EnvironmentApi;
  readonly cwd: string;
  readonly relativePath: string;
}): Promise<ProjectTextFile | null> {
  try {
    const result = await input.api.projects.readFile({
      cwd: input.cwd,
      relativePath: input.relativePath,
    });
    return {
      relativePath: result.relativePath,
      contents: result.contents,
      version: result.version,
    };
  } catch {
    return null;
  }
}

async function detectPackageManager(input: {
  readonly api: EnvironmentApi;
  readonly workspaceRoot: string;
}): Promise<PackageManager> {
  const rootPackageJson = parsePackageJson(
    (
      await readProjectFileIfExists({
        api: input.api,
        cwd: input.workspaceRoot,
        relativePath: "package.json",
      })
    )?.contents ?? "",
  );
  const fromPackageJson = parsePackageManager(rootPackageJson?.packageManager);
  if (fromPackageJson) {
    return fromPackageJson;
  }

  for (const lockfile of ROOT_LOCKFILE_CANDIDATES) {
    const file = await readProjectFileIfExists({
      api: input.api,
      cwd: input.workspaceRoot,
      relativePath: lockfile,
    });
    if (!file) {
      continue;
    }
    switch (lockfile) {
      case "bun.lock":
        return "bun";
      case "pnpm-lock.yaml":
        return "pnpm";
      case "yarn.lock":
        return "yarn";
      default:
        return "npm";
    }
  }

  return "npm";
}

function buildPreviewSetupContents(input: {
  readonly appRoot: string;
  readonly launchCwd: string;
  readonly command: readonly [string, ...string[]];
}): string {
  const launchCwdLine =
    input.launchCwd !== input.appRoot ? `    cwd: ${JSON.stringify(input.launchCwd)},\n` : "";

  return [
    "// Starter preview config scaffolded by Forma.",
    "// Review appRoot, server.cwd, and server.command if this workspace uses a custom dev server.",
    "export default {",
    `  appRoot: ${JSON.stringify(input.appRoot)},`,
    '  framework: "react",',
    '  bundler: "vite",',
    "  server: {",
    `    command: ${formatStringArray(input.command)},`,
    launchCwdLine.trimEnd(),
    "  },",
    "  scan: {",
    `    include: ${formatStringArray([LEGACY_PREVIEW_INCLUDE_GLOB])},`,
    "  },",
    "  components: {",
    `    include: ${formatStringArray([COMPONENT_INCLUDE_GLOB])},`,
    "  },",
    "  graph: {",
    `    include: ${formatStringArray([GRAPH_INCLUDE_GLOB])},`,
    `    exclude: ${formatStringArray(GRAPH_EXCLUDE_GLOBS)},`,
    "  },",
    "};",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function buildStarterViteConfig(input: {
  readonly viteConfigPath: string;
  readonly previewConfigPath: string;
}): string {
  const viteConfigDir = dirname(input.viteConfigPath);
  const previewConfigImport = relativeImportPath(viteConfigDir, input.previewConfigPath);
  return [
    'import { fileURLToPath } from "node:url";',
    'import { defineConfig } from "vite";',
    'import react from "@vitejs/plugin-react";',
    `import previewConfig from ${JSON.stringify(previewConfigImport)};`,
    'import { formaPreviewVitePlugin } from "@forma/preview-react-vite";',
    "",
    `const previewConfigPath = fileURLToPath(new URL(${JSON.stringify(previewConfigImport)}, import.meta.url));`,
    "",
    "export default defineConfig({",
    "  plugins: [react(), formaPreviewVitePlugin(previewConfig, { configPath: previewConfigPath })],",
    "});",
    "",
  ].join("\n");
}

function patchExistingViteConfig(input: {
  readonly contents: string;
  readonly viteConfigPath: string;
  readonly previewConfigPath: string;
}): { readonly contents: string; readonly changed: boolean; readonly note: string | null } {
  if (input.contents.includes("formaPreviewVitePlugin(")) {
    return {
      contents: input.contents,
      changed: false,
      note: null,
    };
  }

  if (!input.contents.includes("plugins:")) {
    return {
      contents: input.contents,
      changed: false,
      note: "Existing vite.config.* could not be patched automatically because it has no plugins array.",
    };
  }

  const viteConfigDir = dirname(input.viteConfigPath);
  const previewConfigImport = relativeImportPath(viteConfigDir, input.previewConfigPath);
  let nextContents = input.contents;

  if (!nextContents.includes('from "node:url"') && !nextContents.includes("from 'node:url'")) {
    nextContents = `import { fileURLToPath } from "node:url";\n${nextContents}`;
  }
  if (
    !nextContents.includes(`from "@forma/preview-react-vite"`) &&
    !nextContents.includes(`from '@forma/preview-react-vite'`)
  ) {
    nextContents = `import { formaPreviewVitePlugin } from "@forma/preview-react-vite";\n${nextContents}`;
  }
  if (
    !nextContents.includes(`previewConfig from "${previewConfigImport}"`) &&
    !nextContents.includes(`previewConfig from '${previewConfigImport}'`)
  ) {
    nextContents = `import previewConfig from ${JSON.stringify(previewConfigImport)};\n${nextContents}`;
  }
  if (!nextContents.includes("const previewConfigPath = fileURLToPath(")) {
    const importBlockMatch = nextContents.match(/^(?:import[\s\S]*?;\n)+/);
    const previewConfigConst = `const previewConfigPath = fileURLToPath(new URL(${JSON.stringify(previewConfigImport)}, import.meta.url));\n\n`;
    if (importBlockMatch) {
      nextContents = `${importBlockMatch[0]}${previewConfigConst}${nextContents.slice(importBlockMatch[0].length)}`;
    } else {
      nextContents = `${previewConfigConst}${nextContents}`;
    }
  }

  const pluginsPattern = /plugins\s*:\s*\[/;
  if (!pluginsPattern.test(nextContents)) {
    return {
      contents: input.contents,
      changed: false,
      note: "Existing vite.config.* could not be patched automatically because the plugins array is not in a supported shape.",
    };
  }

  nextContents = nextContents.replace(
    pluginsPattern,
    "plugins: [\n    formaPreviewVitePlugin(previewConfig, { configPath: previewConfigPath }),",
  );

  return {
    contents: nextContents,
    changed: nextContents !== input.contents,
    note: null,
  };
}

function buildUpdatedPackageJsonContents(input: {
  readonly packageJson: PackageJsonShape;
}): string {
  const parsed = {
    ...input.packageJson,
    devDependencies: {
      ...input.packageJson.devDependencies,
    },
  };

  if (!parsed.devDependencies[PREVIEW_VITE_DEPENDENCY]) {
    parsed.devDependencies[PREVIEW_VITE_DEPENDENCY] = "workspace:*";
  }
  if (!parsed.devDependencies[REACT_VITE_PLUGIN_DEPENDENCY]) {
    parsed.devDependencies[REACT_VITE_PLUGIN_DEPENDENCY] = "^6.0.0";
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function buildPreviewSetupScaffold(input: {
  readonly api: EnvironmentApi;
  readonly workspaceRoot: string;
}): Promise<PreviewSetupScaffold> {
  const notes: string[] = [];
  const writes: PreviewSetupWrite[] = [];

  const viteConfigEntries = await searchEntriesSafe({
    api: input.api,
    cwd: input.workspaceRoot,
    query: "vite.config",
    limit: 50,
  });
  let viteConfigPath = selectPreferredViteConfigPath(viteConfigEntries);

  const packageJsonEntries = await searchEntriesSafe({
    api: input.api,
    cwd: input.workspaceRoot,
    query: "package.json",
    limit: 50,
  });
  const packageFiles = (
    await Promise.all(
      packageJsonEntries.filter(isPackageJsonEntry).map((entry) =>
        readProjectFileIfExists({
          api: input.api,
          cwd: input.workspaceRoot,
          relativePath: normalizePath(entry.path),
        }),
      ),
    )
  ).filter((file): file is ProjectTextFile => file !== null);

  const detectedAppPackage = selectPreferredAppPackage({
    packageFiles,
  });
  const inferredAppRoot = detectedAppPackage ? dirname(detectedAppPackage.relativePath) : ".";
  const appRoot = viteConfigPath ? dirname(viteConfigPath) : inferredAppRoot;

  const packageManager = await detectPackageManager({
    api: input.api,
    workspaceRoot: input.workspaceRoot,
  });

  const appPackageFile =
    packageFiles.find((file) => file.relativePath === joinRelativePath(appRoot, "package.json")) ??
    (appRoot === "."
      ? (packageFiles.find((file) => file.relativePath === "package.json") ?? null)
      : detectedAppPackage);
  const appPackageJson = parsePackageJson(appPackageFile?.contents ?? "");
  const rootPackageFile =
    packageFiles.find((file) => file.relativePath === "package.json") ?? appPackageFile ?? null;
  const rootPackageJson = parsePackageJson(rootPackageFile?.contents ?? "");

  const launchCwd = hasDevScript(appPackageJson)
    ? appRoot
    : hasDevScript(rootPackageJson)
      ? "."
      : appRoot;
  if (!hasDevScript(appPackageJson) && !hasDevScript(rootPackageJson)) {
    notes.push(
      "No package.json dev script was detected automatically. Review server.command and server.cwd in forma.preview.ts.",
    );
  }

  const command = packageManagerCommand(packageManager);

  writes.push({
    relativePath: "forma.preview.ts",
    contents: buildPreviewSetupContents({
      appRoot,
      launchCwd,
      command,
    }),
    expectedVersion: null,
  });

  if (appPackageFile && appPackageJson) {
    const updatedPackageJsonContents = buildUpdatedPackageJsonContents({
      packageJson: appPackageJson,
    });
    if (updatedPackageJsonContents !== appPackageFile.contents) {
      writes.push({
        relativePath: appPackageFile.relativePath,
        contents: updatedPackageJsonContents,
        expectedVersion: appPackageFile.version,
      });
    }
  } else {
    notes.push(
      "No package.json file was detected for the preview app root. Review preview dependencies manually.",
    );
  }

  if (!viteConfigPath) {
    if (usesVite(appPackageJson) || usesVite(rootPackageJson)) {
      viteConfigPath = joinRelativePath(appRoot, "vite.config.ts");
      writes.push({
        relativePath: viteConfigPath,
        contents: buildStarterViteConfig({
          viteConfigPath,
          previewConfigPath: "forma.preview.ts",
        }),
        expectedVersion: null,
      });
    } else {
      notes.push(
        "No vite.config.* file was detected automatically, and this workspace does not look like a Vite app. Preview setup currently supports React + Vite projects.",
      );
    }
  } else {
    const viteConfigFile = await readProjectFileIfExists({
      api: input.api,
      cwd: input.workspaceRoot,
      relativePath: viteConfigPath,
    });
    if (viteConfigFile) {
      const patchedViteConfig = patchExistingViteConfig({
        contents: viteConfigFile.contents,
        viteConfigPath,
        previewConfigPath: "forma.preview.ts",
      });
      if (patchedViteConfig.changed) {
        writes.push({
          relativePath: viteConfigPath,
          contents: patchedViteConfig.contents,
          expectedVersion: viteConfigFile.version,
        });
      }
      if (patchedViteConfig.note) {
        notes.push(patchedViteConfig.note);
      }
    } else {
      notes.push("A vite.config.* path was detected but could not be read for automatic patching.");
    }
  }

  if (writes.length === 1 && !viteConfigPath) {
    notes.push(
      "Preview setup created forma.preview.ts, but Vite plugin wiring still needs to be added.",
    );
  }

  return {
    appRoot,
    launchCwd,
    command,
    writes,
    notes,
    viteConfigPath,
  };
}

export const __test__ = {
  buildPreviewSetupContents,
  buildStarterViteConfig,
  patchExistingViteConfig,
  selectPreferredAppPackage,
  selectPreferredViteConfigPath,
  packageManagerCommand,
  relativeImportPath,
};
