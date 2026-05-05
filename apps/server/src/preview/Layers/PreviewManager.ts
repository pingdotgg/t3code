import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  CommandId,
  type PreviewEnsureRuntimeResult,
  type PreviewFramework,
  type PreviewIssueAccessTokenResult,
  type PreviewPrepareBootstrapThreadResult,
  type PreviewPreparePreviewGenerationTurnResult,
  type PreviewPreparePreviewRepairTurnResult,
  type PreviewProjectEvent,
  type PreviewProjectInspectionResult,
  type PreviewResolveTargetResult,
  type PreviewScenarioEntry,
  type PreviewSearchComponentsResult,
  PreviewRpcError,
  type ProjectId,
  ProjectRelativePath,
  type ProjectPreviewWorkspaceRecord,
} from "@forma/contracts";
import { Cause, Effect, Exit, Layer, PubSub, Ref, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  PreviewManager,
  type PreviewManagerShape,
  type PreviewRuntimeTarget,
} from "../Services/PreviewManager.ts";
import { aliasEntriesFromTsconfigPaths, type AliasEntry } from "./previewAliases.ts";
import {
  buildPreviewRuntimeWarmupPlan,
  parsePreviewComponentRelativePath,
  resolvePreviewComponentPath,
} from "./previewRuntimeWarmup.ts";

interface ProjectRecord {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly previewWorkspaceRecords: readonly ProjectPreviewWorkspaceRecord[];
}

interface PackageJsonRecord {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly bin?: string | Record<string, string>;
}

interface PreviewAccessTokenRecord {
  readonly token: string;
  readonly projectId: ProjectId;
  readonly expiresAtMs: number;
}

interface TsConfigRecord {
  readonly compilerOptions?: {
    readonly baseUrl?: string;
    readonly paths?: Record<string, readonly string[]>;
  };
}

interface ResolvedHarnessTarget {
  readonly projectId: ProjectId;
  readonly relativePath: string;
  readonly previewFileRelativePath: string;
  readonly workspaceRootRelativePath: string;
  readonly framework: PreviewFramework;
  readonly scenarioChoices: readonly PreviewScenarioEntry[];
  readonly initialScenarioId: string | null;
  readonly moduleMocks: Readonly<Record<string, string>>;
  readonly aliasEntries: readonly AliasEntry[];
  readonly previewComponentRelativePath: string | null;
}

interface RuntimeRecord {
  readonly projectId: ProjectId;
  readonly relativePath: string;
  readonly previewFileRelativePath: string;
  readonly runtimeDir: string;
  readonly cacheDir: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly iframeBasePath: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly logs: string[];
  readonly readinessPaths: readonly string[];
  readonly startedAt: string;
  readonly lastHealthCheckAt: string | null;
}

interface PreviewManagerState {
  readonly runtimes: Map<ProjectId, RuntimeRecord>;
  readonly projectPubSubs: Map<ProjectId, PubSub.PubSub<PreviewProjectEvent>>;
  readonly accessTokens: Map<string, PreviewAccessTokenRecord>;
  readonly lastResolvedTargets: Map<ProjectId, ResolvedHarnessTarget>;
}

const PREVIEW_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const PREVIEW_RUNTIME_HOST = "127.0.0.1";
const IGNORED_DIRS = new Set([
  ".forma",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);
const COMPONENT_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".ts", ".js"]);
const BOOTSTRAP_FILE_PATHS = [
  ".forma/preview/config.ts",
  ".forma/preview/wrapper.tsx",
  ".forma/preview/mocks.ts",
] as const;

function resolveHarnessAssetPath(relativePath: string): string {
  const candidates = [
    fileURLToPath(new URL(`../harness/${relativePath}`, import.meta.url)),
    fileURLToPath(new URL(`./harness/${relativePath}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

const HARNESS_VITE_CONFIG_PATH = resolveHarnessAssetPath("vite.config.ts");
const HARNESS_RUNTIME_MODULE_PATH = resolveHarnessAssetPath("runtime.tsx");

function pruneExpiredAccessTokens(state: PreviewManagerState, nowMs = Date.now()) {
  return new Map(
    [...state.accessTokens.entries()].filter(([, record]) => record.expiresAtMs > nowMs),
  );
}

function toPreviewError(message: string, _cause?: unknown): PreviewRpcError {
  return new PreviewRpcError({ message });
}

function failPreview(message: string, cause?: unknown) {
  return Effect.fail(toPreviewError(message, cause));
}

function normalizeProjectPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function asProjectRelativePath(relativePath: string) {
  return ProjectRelativePath.make(normalizeProjectPath(relativePath));
}

function displayNameForPath(relativePath: string): string {
  const basename = path.basename(relativePath).replace(/\.[^.]+$/, "");
  return basename.replace(/[-_]+/g, " ").trim() || basename;
}

function isComponentPath(relativePath: string): boolean {
  const normalized = normalizeProjectPath(relativePath);
  if (normalized.endsWith(".d.ts")) return false;
  if (/\.(stories|story|preview)\.[^.]+$/i.test(normalized)) return false;
  if (/(\.test|\.spec)\.[^.]+$/i.test(normalized)) return false;
  return COMPONENT_EXTENSIONS.has(path.extname(normalized));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(currentDir: string): Promise<void> {
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) continue;
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeProjectPath(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(absolutePath);
        continue;
      }
      results.push(relativePath);
    }
  }
  await walk(root);
  return results;
}

function resolveFrameworkFromPackage(pkg: PackageJsonRecord | null): PreviewFramework {
  const dependencies = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
  };
  if ("next" in dependencies) return "react-next";
  if ("@remix-run/react" in dependencies) return "react-remix";
  if ("react-router" in dependencies || "react-router-dom" in dependencies) return "react-router";
  if ("react" in dependencies) return "react-vite";
  return "unsupported";
}

async function resolveWorkspaceRootRelativePath(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  const absoluteTargetPath = path.join(projectRoot, relativePath);
  let currentDir = path.dirname(absoluteTargetPath);
  const normalizedProjectRoot = path.resolve(projectRoot);
  while (currentDir.startsWith(normalizedProjectRoot)) {
    if (await pathExists(path.join(currentDir, "package.json"))) {
      return normalizeProjectPath(path.relative(projectRoot, currentDir));
    }
    const nextDir = path.dirname(currentDir);
    if (nextDir === currentDir) {
      break;
    }
    currentDir = nextDir;
  }
  return "";
}

async function resolveWorkspacePackageJson(
  projectRoot: string,
  workspaceRootRelativePath: string,
): Promise<PackageJsonRecord | null> {
  const workspaceRoot = path.join(projectRoot, workspaceRootRelativePath);
  const directPackage = await readJsonFile<PackageJsonRecord>(
    path.join(workspaceRoot, "package.json"),
  );
  if (directPackage) {
    return directPackage;
  }
  if (workspaceRootRelativePath.length === 0) {
    return directPackage;
  }
  return await readJsonFile<PackageJsonRecord>(path.join(projectRoot, "package.json"));
}

async function detectProjectFramework(
  projectRoot: string,
  relativePath?: string,
): Promise<PreviewFramework> {
  if (relativePath) {
    const workspaceRootRelativePath = await resolveWorkspaceRootRelativePath(
      projectRoot,
      relativePath,
    );
    return resolveFrameworkFromPackage(
      await resolveWorkspacePackageJson(projectRoot, workspaceRootRelativePath),
    );
  }
  const rootPackageJson = await readJsonFile<PackageJsonRecord>(
    path.join(projectRoot, "package.json"),
  );
  const rootFramework = resolveFrameworkFromPackage(rootPackageJson);
  if (rootFramework !== "unsupported") {
    return rootFramework;
  }
  const files = await listRelativeFiles(projectRoot);
  const packageJsonPaths = files.filter(
    (file) => file.endsWith("/package.json") || file === "package.json",
  );
  for (const packageJsonPath of packageJsonPaths) {
    const pkg = await readJsonFile<PackageJsonRecord>(path.join(projectRoot, packageJsonPath));
    const framework = resolveFrameworkFromPackage(pkg);
    if (framework !== "unsupported") {
      return framework;
    }
  }
  return "unsupported";
}

async function hasBootstrapFiles(projectRoot: string): Promise<boolean> {
  for (const relativePath of BOOTSTRAP_FILE_PATHS) {
    if (!(await pathExists(path.join(projectRoot, relativePath)))) {
      return false;
    }
  }
  return true;
}

function previewFilePathForComponent(componentRelativePath: string): string {
  const normalized = normalizeProjectPath(componentRelativePath);
  const extension = path.extname(normalized);
  const stem = normalized.slice(0, normalized.length - extension.length);
  return `${stem}.preview.tsx`;
}

function workspaceLabel(workspaceRootRelativePath: string): string {
  return workspaceRootRelativePath.trim().length > 0 ? workspaceRootRelativePath : "project root";
}

function buildThreadTitle(workspaceRootRelativePath: string) {
  return `Preview setup · ${workspaceLabel(workspaceRootRelativePath)}`;
}

function getWorkspaceRecord(
  project: ProjectRecord,
  workspaceRootRelativePath: string,
): ProjectPreviewWorkspaceRecord | null {
  const normalizedWorkspaceRoot = normalizeProjectPath(workspaceRootRelativePath);
  return (
    project.previewWorkspaceRecords.find(
      (record) =>
        normalizeProjectPath(record.workspaceRootRelativePath) === normalizedWorkspaceRoot,
    ) ?? null
  );
}

function upsertWorkspaceRecord(
  records: readonly ProjectPreviewWorkspaceRecord[],
  nextRecord: ProjectPreviewWorkspaceRecord,
): readonly ProjectPreviewWorkspaceRecord[] {
  const normalizedWorkspaceRoot = normalizeProjectPath(nextRecord.workspaceRootRelativePath);
  const remaining = records.filter(
    (record) => normalizeProjectPath(record.workspaceRootRelativePath) !== normalizedWorkspaceRoot,
  );
  return [...remaining, nextRecord].toSorted((left, right) =>
    left.workspaceRootRelativePath.localeCompare(right.workspaceRootRelativePath),
  );
}

function normalizeViteFsPath(filePath: string): string {
  const resolved = path.resolve(filePath).replaceAll("\\", "/");
  return resolved.startsWith("/") ? `/@fs${resolved}` : `/@fs/${resolved}`;
}

function requireResolveFromRoots(searchRoots: readonly string[], specifier: string): string {
  const runtimeRequire = createRequire(import.meta.url);
  for (const searchRoot of searchRoots) {
    try {
      const requireFromRoot = createRequire(path.join(searchRoot, "package.json"));
      return requireFromRoot.resolve(specifier);
    } catch {
      // Try the next candidate root.
    }
  }
  return runtimeRequire.resolve(specifier);
}

async function resolvePackageBinPath(
  searchRoots: readonly string[],
  packageName: string,
  binName = packageName,
): Promise<string> {
  const packageJsonPath = requireResolveFromRoots(searchRoots, `${packageName}/package.json`);
  const packageJson = await readJsonFile<PackageJsonRecord>(packageJsonPath);
  if (!packageJson?.bin) {
    throw new Error(`Package "${packageName}" does not define a CLI entry.`);
  }
  const relativeBinPath =
    typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin[binName];
  if (!relativeBinPath) {
    throw new Error(`Package "${packageName}" does not define a "${binName}" CLI entry.`);
  }
  return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
}

async function inferAliasEntries(
  projectRoot: string,
  relativePath: string,
  workspaceRootRelativePath: string,
): Promise<readonly AliasEntry[]> {
  const workspaceRoot = path.join(projectRoot, workspaceRootRelativePath);
  const candidateConfigPaths = [
    path.join(workspaceRoot, "tsconfig.json"),
    path.join(workspaceRoot, "jsconfig.json"),
    path.join(projectRoot, "tsconfig.json"),
    path.join(projectRoot, "jsconfig.json"),
  ].filter((candidatePath, index, entries) => entries.indexOf(candidatePath) === index);

  const configuredAliasEntries = (
    await Promise.all(
      candidateConfigPaths.map(async (configPath) => {
        const config = await readJsonFile<TsConfigRecord>(configPath);
        if (!config?.compilerOptions?.paths) {
          return [];
        }
        const aliasEntries = aliasEntriesFromTsconfigPaths(config.compilerOptions.paths, {
          configDir: path.dirname(configPath),
          ...(config.compilerOptions.baseUrl ? { baseUrl: config.compilerOptions.baseUrl } : {}),
        });
        return (
          await Promise.all(
            aliasEntries.map(async (entry) =>
              (await pathExists(entry.replacement)) ? entry : null,
            ),
          )
        ).flatMap((entry) => (entry ? [entry] : []));
      }),
    )
  ).flat();

  const normalized = normalizeProjectPath(relativePath);
  const srcMarker = "/src/";
  const markerIndex = normalized.lastIndexOf(srcMarker);
  const candidateRoots: string[] = [];
  if (markerIndex >= 0) {
    candidateRoots.push(
      path.join(projectRoot, normalized.slice(0, markerIndex + srcMarker.length)),
    );
  }
  candidateRoots.push(path.join(workspaceRoot, "src"));
  candidateRoots.push(path.join(projectRoot, "src"));

  const inferredAliasEntries: AliasEntry[] = [];
  for (const candidateRoot of candidateRoots) {
    if (await pathExists(candidateRoot)) {
      inferredAliasEntries.push({ find: "@", replacement: candidateRoot });
      break;
    }
  }

  const dedupedEntries = [...configuredAliasEntries, ...inferredAliasEntries].filter(
    (entry, index, entries) =>
      entries.findIndex((candidate) => candidate.find === entry.find) === index,
  );

  return dedupedEntries;
}

function parseScenarioChoices(source: string): readonly PreviewScenarioEntry[] {
  const scenarioSectionMatch = source.match(
    /scenarios\s*:\s*\[([\s\S]*?)\]\s*(?:,\s*(?:controls|moduleMocks|envDefaults|component|componentExport)|\}\s*\))/,
  );
  const scenarioSection = scenarioSectionMatch?.[1] ?? source;
  const scenarioMatches = [
    ...scenarioSection.matchAll(
      /id\s*:\s*["'`]([^"'`]+)["'`][\s\S]*?name\s*:\s*["'`]([^"'`]+)["'`]/g,
    ),
  ];
  return scenarioMatches.map((match) => ({
    id: match[1]!,
    name: match[2]!,
  }));
}

function parseModuleMocks(
  source: string,
  previewFileRelativePath: string,
): Readonly<Record<string, string>> {
  const moduleMocksMatch = source.match(
    /moduleMocks\s*:\s*\{([\s\S]*?)\}\s*(?:,\s*(?:envDefaults|controls|component|componentExport)|\}\s*\))/,
  );
  if (!moduleMocksMatch) {
    return {};
  }
  const matches = [
    ...moduleMocksMatch[1]!.matchAll(/["'`]([^"'`]+)["'`]\s*:\s*["'`]([^"'`]+)["'`]/g),
  ];
  const directory = path.posix.dirname(normalizeProjectPath(previewFileRelativePath));
  const entries = matches.map((match) => {
    const rawPath = match[2]!;
    const resolvedPath = rawPath.startsWith(".")
      ? normalizeProjectPath(path.posix.join(directory, rawPath))
      : normalizeProjectPath(rawPath);
    return [match[1]!, resolvedPath] as const;
  });
  return Object.fromEntries(entries);
}

function parsePreviewComponentPath(source: string, previewFileRelativePath: string): string | null {
  const componentRelativePath = parsePreviewComponentRelativePath(source);
  if (!componentRelativePath) {
    return null;
  }
  if (!componentRelativePath.startsWith(".")) {
    return normalizeProjectPath(componentRelativePath);
  }
  return normalizeProjectPath(
    path.posix.join(
      path.posix.dirname(normalizeProjectPath(previewFileRelativePath)),
      componentRelativePath,
    ),
  );
}

async function inspectPreviewFile(
  projectRoot: string,
  previewFileRelativePath: string,
): Promise<{
  readonly scenarioChoices: readonly PreviewScenarioEntry[];
  readonly initialScenarioId: string | null;
  readonly moduleMocks: Readonly<Record<string, string>>;
  readonly previewComponentRelativePath: string | null;
}> {
  const source = await readTextFile(path.join(projectRoot, previewFileRelativePath));
  if (!source) {
    return {
      scenarioChoices: [],
      initialScenarioId: null,
      moduleMocks: {},
      previewComponentRelativePath: null,
    };
  }
  const scenarioChoices = parseScenarioChoices(source);
  return {
    scenarioChoices,
    initialScenarioId: scenarioChoices[0]?.id ?? null,
    moduleMocks: parseModuleMocks(source, previewFileRelativePath),
    previewComponentRelativePath: parsePreviewComponentPath(source, previewFileRelativePath),
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, PREVIEW_RUNTIME_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not resolve preview runtime port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function fetchRuntimePath(baseUrl: string, runtimePath: string): Promise<Response> {
  const normalizedPath = runtimePath.startsWith("/") ? runtimePath : `/${runtimePath}`;
  return await fetch(`${baseUrl}${encodeURI(normalizedPath)}`);
}

export async function waitForRuntimeReady(
  baseUrl: string,
  timeoutMs = 30_000,
  readinessPaths: readonly string[] = ["/preview.html"],
): Promise<void> {
  const startedAt = Date.now();
  let lastFailure: string | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const failedPath = await (async () => {
        for (const readinessPath of readinessPaths) {
          const response = await fetchRuntimePath(baseUrl, readinessPath);
          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            const trimmedDetail = detail.trim();
            return trimmedDetail.length > 0
              ? `${readinessPath} returned ${response.status}: ${trimmedDetail.slice(0, 240)}`
              : `${readinessPath} returned ${response.status}`;
          }
        }
        return null;
      })();
      if (!failedPath) {
        return;
      }
      lastFailure = failedPath;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    lastFailure
      ? `Timed out waiting for the preview harness runtime. Last readiness failure: ${lastFailure}`
      : "Timed out waiting for the preview harness runtime.",
  );
}

async function isRuntimeReady(
  baseUrl: string,
  readinessPaths?: readonly string[],
): Promise<boolean> {
  try {
    await waitForRuntimeReady(baseUrl, 1_500, readinessPaths);
    return true;
  } catch {
    return false;
  }
}

async function createRuntimeWorkspace(args: {
  readonly projectRoot: string;
  readonly componentRelativePath: string;
  readonly previewFileRelativePath: string;
  readonly previewComponentRelativePath: string | null;
  readonly moduleMocks: Readonly<Record<string, string>>;
  readonly framework: PreviewFramework;
}): Promise<string> {
  const runtimeDir = path.join(os.tmpdir(), "forma-preview-harness", randomUUID().slice(0, 12));
  await fsPromises.mkdir(path.join(runtimeDir, "src"), { recursive: true });
  const defaultComponentModuleUrl = normalizeViteFsPath(
    path.join(args.projectRoot, args.componentRelativePath),
  );
  const previewModuleUrl = normalizeViteFsPath(
    path.join(args.projectRoot, args.previewFileRelativePath),
  );
  const wrapperModuleUrl = normalizeViteFsPath(
    path.join(args.projectRoot, ".forma/preview/wrapper.tsx"),
  );
  const mocksModuleUrl = normalizeViteFsPath(
    path.join(args.projectRoot, ".forma/preview/mocks.ts"),
  );
  const optimizerComponentPath = resolvePreviewComponentPath({
    projectRoot: args.projectRoot,
    previewFilePath: path.join(args.projectRoot, args.previewFileRelativePath),
    componentRelativePath: args.componentRelativePath,
    previewComponentRelativePath: args.previewComponentRelativePath,
  });
  const optimizerComponentModuleUrl = normalizeViteFsPath(optimizerComponentPath);
  const optimizerMockModuleUrls = Object.values(args.moduleMocks).map((relativePath) =>
    normalizeViteFsPath(path.join(args.projectRoot, relativePath)),
  );
  const runtimeHelperUrl = normalizeViteFsPath(HARNESS_RUNTIME_MODULE_PATH);

  const mainSource = `import * as previewModule from ${JSON.stringify(previewModuleUrl)};
import * as wrapperModule from ${JSON.stringify(wrapperModuleUrl)};
import ${JSON.stringify(mocksModuleUrl)};
import { startPreviewRuntime } from ${JSON.stringify(runtimeHelperUrl)};

const previewDefinition = (previewModule.default ?? previewModule.preview ?? previewModule);
const previewModuleBaseUrl = new URL(${JSON.stringify(previewModuleUrl)}, window.location.origin);
const componentModuleUrl =
  typeof previewDefinition?.component === "string" && previewDefinition.component.trim().length > 0
    ? new URL(previewDefinition.component, previewModuleBaseUrl).pathname
    : ${JSON.stringify(defaultComponentModuleUrl)};

startPreviewRuntime({
  componentModuleUrl,
  componentRelativePath: ${JSON.stringify(args.componentRelativePath)},
  framework: ${JSON.stringify(args.framework)},
  mountElementId: "app",
  previewDefinition,
  previewFileRelativePath: ${JSON.stringify(args.previewFileRelativePath)},
  wrapperModule,
});
`;

  const optimizerEntrySource = [
    `import ${JSON.stringify("./main.tsx")};`,
    `import ${JSON.stringify(previewModuleUrl)};`,
    `import ${JSON.stringify(wrapperModuleUrl)};`,
    `import ${JSON.stringify(mocksModuleUrl)};`,
    `import ${JSON.stringify(optimizerComponentModuleUrl)};`,
    ...optimizerMockModuleUrls.map((moduleUrl) => `import ${JSON.stringify(moduleUrl)};`),
  ].join("\n");

  const htmlSource = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Forma Preview</title>
    <style>
      html, body, #app {
        height: 100%;
        margin: 0;
        background: transparent !important;
        background-color: transparent !important;
      }
      body {
        background: transparent !important;
        background-color: transparent !important;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

  await fsPromises.writeFile(path.join(runtimeDir, "src/main.tsx"), mainSource, "utf8");
  await fsPromises.writeFile(
    path.join(runtimeDir, "src/optimizer-entry.ts"),
    `${optimizerEntrySource}\n`,
    "utf8",
  );
  await fsPromises.writeFile(path.join(runtimeDir, "preview.html"), htmlSource, "utf8");
  return runtimeDir;
}

function buildBootstrapPrompt(args: {
  readonly project: ProjectRecord;
  readonly framework: PreviewFramework;
  readonly workspaceRootRelativePath: string;
  readonly relativePath: string;
}) {
  return `Set up Forma's component preview harness for project \`${args.project.title}\`.

Selected component:
- path: \`${args.relativePath}\`
- owner workspace: \`${workspaceLabel(args.workspaceRootRelativePath)}\`
- detected framework: \`${args.framework}\`

Create these repo-level files exactly once under \`.forma/preview/\`:
- \`config.ts\`
- \`wrapper.tsx\`
- \`mocks.ts\`

Requirements:
- \`config.ts\` must export a typed \`defineComponentPreview(...)\` helper and the preview definition types.
- Preview definitions must stay deterministic and data-only. Do not import the component inside \`*.preview.tsx\`.
- \`wrapper.tsx\` must default-export a React wrapper component for preview providers, CSS, and app context.
- \`mocks.ts\` should set up shared deterministic mocks and no-op analytics where appropriate.
- If the workspace depends on a local/shared UI package that exports global CSS utilities, theme variables, or motion classes, import that package stylesheet from \`wrapper.tsx\` in addition to the app's global stylesheet. Use a repo-local relative import when workspace package export resolution is unreliable in preview.
- Prefer repo-level providers and fetch/network mocking over live data.
- Do not add Storybook or any full-app dev-server dependency to this flow.
- Use normal module specifiers like \`react\`, \`next/navigation\`, and repo aliases. Do not import from \`node_modules\` paths or absolute filesystem paths.
- Keep \`moduleMocks\` typed as \`Record<string, string>\` where values are mock module paths.
- Keep \`controls\` typed as objects with \`name\`, optional \`label\`/\`description\`, \`type\`, and optional \`defaultValue\`.

The harness expects each component preview file to look like:
\`\`\`ts
import { defineComponentPreview } from "./relative/path/to/.forma/preview/config";

export default defineComponentPreview({
  component: "./Component.tsx",
  componentExport: "NamedExportOrDefault",
  scenarios: [
    {
      id: "default",
      name: "Default",
      args: {},
      env: {
        pathname: "/",
        searchParams: {},
      },
    },
  ],
  controls: [],
  moduleMocks: {},
});
\`\`\`

Keep the exported preview object static and serializable so Forma can parse it without executing the component module.

When finished, summarize the files you changed and any repo-specific assumptions the preview wrapper makes.`;
}

function buildPreviewGenerationPrompt(args: {
  readonly relativePath: string;
  readonly previewFileRelativePath: string;
}) {
  const configImportPath = path.posix.relative(
    path.posix.dirname(normalizeProjectPath(args.previewFileRelativePath)),
    ".forma/preview/config.ts",
  );
  const normalizedConfigImportPath = configImportPath.startsWith(".")
    ? configImportPath
    : `./${configImportPath}`;

  return `Create or update the component preview file \`${args.previewFileRelativePath}\` for \`${args.relativePath}\`.

Requirements:
- Import \`defineComponentPreview\` from \`${normalizedConfigImportPath}\`.
- Export a single static preview definition object.
- Do not import the component in the preview file. Use \`component\` and \`componentExport\` string fields.
- Keep the file deterministic and repo-reusable.
- Prefer fetch/query mocks and preview args over live data.
- If a colocated mock module is needed, create \`${args.previewFileRelativePath.replace(/\.tsx$/, ".mocks.ts")}\`.
- Provide multiple named scenarios when the component has materially different states.
- If you declare controls, use the runtime shape: \`{ name, label?, description?, type?, options?, defaultValue? }\`.
- If you declare module mocks, use string module paths: \`Record<string, string>\`.

Minimum preview contract:
\`\`\`ts
import { defineComponentPreview } from "${normalizedConfigImportPath}";

export default defineComponentPreview({
  component: "./${path.posix.basename(args.relativePath)}",
  componentExport: "default",
  scenarios: [
    {
      id: "default",
      name: "Default",
      args: {},
      env: {
        pathname: "/",
        searchParams: {},
      },
    },
  ],
  controls: [],
  moduleMocks: {},
});
\`\`\`

If the component has named exports, set \`componentExport\` correctly.
If the component depends on router/query state, encode that in the scenario \`env\`.
If the component needs deterministic data, encode that in preview args and mocks.

When finished, summarize the scenarios you created and why they cover the component well.`;
}

function buildPreviewRepairPrompt(args: {
  readonly relativePath: string;
  readonly previewFileRelativePath: string | null;
  readonly errorMessage: string;
}) {
  return `Repair the Forma component preview for \`${args.relativePath}\`.

Current preview file:
- ${args.previewFileRelativePath ? `\`${args.previewFileRelativePath}\`` : "preview file missing or unresolved"}

Error:
\`\`\`
${args.errorMessage}
\`\`\`

Requirements:
- Repair the existing preview artifacts in place instead of regenerating unrelated files.
- Keep the preview definition static and deterministic.
- Preserve any useful scenarios and controls that already exist.
- If the failure is caused by framework/router/query dependencies, fix it through the preview wrapper, preview mocks, or the preview scenario contract.

When finished, summarize the exact files changed and what caused the failure.`;
}

const makePreviewManager = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const stateRef = yield* Ref.make<PreviewManagerState>({
    runtimes: new Map(),
    projectPubSubs: new Map(),
    accessTokens: new Map(),
    lastResolvedTargets: new Map(),
  });

  const ensureProjectPubSub = (
    projectId: ProjectId,
  ): Effect.Effect<PubSub.PubSub<PreviewProjectEvent>, never> =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(stateRef)).projectPubSubs.get(projectId);
      if (existing) return existing;
      const next = yield* PubSub.unbounded<PreviewProjectEvent>();
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        projectPubSubs: new Map(state.projectPubSubs).set(projectId, next),
      }));
      return next;
    });

  const publishProjectEvent = (
    projectId: ProjectId,
    event: PreviewProjectEvent,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const pubsub = yield* ensureProjectPubSub(projectId);
      yield* PubSub.publish(pubsub, event);
    });

  const issueAccessTokenForProject = (
    projectId: ProjectId,
  ): Effect.Effect<PreviewIssueAccessTokenResult, never> =>
    Effect.gen(function* () {
      const token = randomUUID();
      const record: PreviewAccessTokenRecord = {
        token,
        projectId,
        expiresAtMs: Date.now() + PREVIEW_ACCESS_TOKEN_TTL_MS,
      };
      yield* Ref.update(stateRef, (state) => {
        const nextTokens = pruneExpiredAccessTokens(state);
        nextTokens.set(token, record);
        return {
          ...state,
          accessTokens: nextTokens,
        };
      });
      return {
        projectId,
        accessToken: token,
      } satisfies PreviewIssueAccessTokenResult;
    });

  const getProjectById = (projectId: ProjectId): Effect.Effect<ProjectRecord, PreviewRpcError> =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine
        .getReadModel()
        .pipe(
          Effect.mapError((cause) =>
            toPreviewError("Failed to load the orchestration read model.", cause),
          ),
        );
      const project = readModel.projects.find(
        (entry) => entry.id === projectId && entry.deletedAt === null,
      );
      if (!project) {
        return yield* failPreview(`Project '${projectId}' was not found.`);
      }
      return {
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        previewWorkspaceRecords: project.previewWorkspaceRecords ?? [],
      } satisfies ProjectRecord;
    });

  const updateProjectPreviewMetadata = (
    project: ProjectRecord,
    previewWorkspaceRecords: readonly ProjectPreviewWorkspaceRecord[],
  ) =>
    orchestrationEngine
      .dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(`preview-meta:${randomUUID()}`),
        projectId: project.id,
        previewWorkspaceRecords: [...previewWorkspaceRecords],
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          toPreviewError("Failed to update preview workspace records.", cause),
        ),
      );

  const persistWorkspaceRecord = (
    project: ProjectRecord,
    patch: {
      readonly workspaceRootRelativePath: string;
      readonly threadId?: ProjectPreviewWorkspaceRecord["threadId"] | undefined;
      readonly status: ProjectPreviewWorkspaceRecord["status"];
      readonly lastPreviewFileRelativePath?: string | null | undefined;
      readonly lastError?: string | null | undefined;
    },
  ): Effect.Effect<void, PreviewRpcError> => {
    const currentRecord = getWorkspaceRecord(project, patch.workspaceRootRelativePath);
    const nextRecord: ProjectPreviewWorkspaceRecord = {
      workspaceRootRelativePath: normalizeProjectPath(patch.workspaceRootRelativePath),
      threadId: patch.threadId !== undefined ? patch.threadId : (currentRecord?.threadId ?? null),
      status: patch.status,
      lastPreviewFileRelativePath:
        patch.lastPreviewFileRelativePath !== undefined
          ? patch.lastPreviewFileRelativePath
            ? asProjectRelativePath(patch.lastPreviewFileRelativePath)
            : null
          : (currentRecord?.lastPreviewFileRelativePath ?? null),
      lastError:
        patch.lastError !== undefined ? patch.lastError : (currentRecord?.lastError ?? null),
      updatedAt: new Date().toISOString(),
    };
    return updateProjectPreviewMetadata(
      project,
      upsertWorkspaceRecord(project.previewWorkspaceRecords, nextRecord),
    );
  };

  const inspectProject: PreviewManagerShape["inspectProject"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      return yield* Effect.tryPromise({
        try: async () => {
          const framework = await detectProjectFramework(project.workspaceRoot);
          const bootstrapFilesPresent = await hasBootstrapFiles(project.workspaceRoot);
          const status =
            framework === "unsupported"
              ? "unsupported"
              : bootstrapFilesPresent
                ? "ready"
                : "needsBootstrap";
          return {
            projectId: project.id,
            provider: "componentHarness",
            framework,
            status,
            bootstrapFilesPresent,
            summary:
              status === "ready"
                ? "Component preview harness is configured."
                : status === "needsBootstrap"
                  ? "Forma needs repo-level preview bootstrap files before component previews can render."
                  : "Forma preview harness currently supports React-family repos only.",
          } satisfies PreviewProjectInspectionResult;
        },
        catch: (cause) => toPreviewError("Failed to inspect project preview configuration.", cause),
      });
    });

  const searchComponents: PreviewManagerShape["searchComponents"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      return yield* Effect.tryPromise({
        try: async () => {
          const files = await listRelativeFiles(project.workspaceRoot);
          const normalizedQuery = input.query.trim().toLowerCase();
          const components = files
            .filter(isComponentPath)
            .map((relativePath) => ({
              relativePath: asProjectRelativePath(relativePath),
              displayName: displayNameForPath(relativePath),
            }))
            .filter(
              (entry) =>
                entry.displayName.toLowerCase().includes(normalizedQuery) ||
                entry.relativePath.toLowerCase().includes(normalizedQuery),
            )
            .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
          return {
            components: components.slice(0, input.limit),
            truncated: components.length > input.limit,
          } satisfies PreviewSearchComponentsResult;
        },
        catch: (cause) => toPreviewError("Failed to search project components.", cause),
      });
    });

  const stopRuntimeRecord = (runtime: RuntimeRecord): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      runtime.child.kill("SIGTERM");
      yield* Effect.tryPromise({
        try: () => fsPromises.rm(runtime.runtimeDir, { recursive: true, force: true }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
    });

  const startRuntimeForTarget = (
    project: ProjectRecord,
    target: ResolvedHarnessTarget,
  ): Effect.Effect<PreviewEnsureRuntimeResult, PreviewRpcError> =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(stateRef)).runtimes.get(project.id);
      if (existing) {
        if (
          existing.relativePath === target.relativePath &&
          existing.previewFileRelativePath === target.previewFileRelativePath
        ) {
          const healthy = yield* Effect.promise(() =>
            isRuntimeReady(existing.baseUrl, existing.readinessPaths),
          );
          if (healthy) {
            return {
              projectId: project.id,
              provider: "componentHarness",
              started: false,
              iframeBasePath: existing.iframeBasePath,
            } satisfies PreviewEnsureRuntimeResult;
          }
        }
        yield* stopRuntimeRecord(existing);
        yield* Ref.update(stateRef, (state) => {
          const nextRuntimes = new Map(state.runtimes);
          nextRuntimes.delete(project.id);
          return { ...state, runtimes: nextRuntimes };
        });
      }

      yield* ensureProjectPubSub(project.id);
      yield* publishProjectEvent(project.id, {
        kind: "runtime.starting",
        projectId: project.id,
      });

      const port = yield* Effect.tryPromise({
        try: () => allocatePort(),
        catch: (cause) => toPreviewError("Failed to allocate a preview runtime port.", cause),
      });
      const runtimeDir = yield* Effect.tryPromise({
        try: () =>
          createRuntimeWorkspace({
            projectRoot: project.workspaceRoot,
            componentRelativePath: target.relativePath,
            previewFileRelativePath: target.previewFileRelativePath,
            previewComponentRelativePath: target.previewComponentRelativePath,
            moduleMocks: target.moduleMocks,
            framework: target.framework,
          }),
        catch: (cause) => toPreviewError("Failed to create preview runtime workspace.", cause),
      });
      const workspaceRoot = path.join(project.workspaceRoot, target.workspaceRootRelativePath);
      const warmupPlan = buildPreviewRuntimeWarmupPlan({
        projectRoot: project.workspaceRoot,
        workspaceRoot,
        runtimeDir,
        harnessRuntimeModulePath: HARNESS_RUNTIME_MODULE_PATH,
        componentRelativePath: target.relativePath,
        previewFileRelativePath: target.previewFileRelativePath,
        previewComponentRelativePath: target.previewComponentRelativePath,
        moduleMocks: target.moduleMocks,
      });
      const resolutionRoots = [workspaceRoot, project.workspaceRoot];
      const reactAliases = {
        react: requireResolveFromRoots(resolutionRoots, "react"),
        "react/jsx-dev-runtime": requireResolveFromRoots(resolutionRoots, "react/jsx-dev-runtime"),
        "react/jsx-runtime": requireResolveFromRoots(resolutionRoots, "react/jsx-runtime"),
        "react-dom": requireResolveFromRoots(resolutionRoots, "react-dom"),
        "react-dom/client": requireResolveFromRoots(resolutionRoots, "react-dom/client"),
      };
      const viteCliPath = yield* Effect.tryPromise({
        try: () => resolvePackageBinPath([process.cwd()], "vite"),
        catch: (cause) => toPreviewError("Failed to locate the Vite preview runtime CLI.", cause),
      });
      const child = spawn(process.execPath, [viteCliPath, "--config", HARNESS_VITE_CONFIG_PATH], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          FORMA_PREVIEW_RUNTIME_ROOT: runtimeDir,
          FORMA_PREVIEW_PROJECT_ROOT: project.workspaceRoot,
          FORMA_PREVIEW_WORKSPACE_ROOT: workspaceRoot,
          FORMA_PREVIEW_FRAMEWORK: target.framework,
          FORMA_PREVIEW_HOST: PREVIEW_RUNTIME_HOST,
          FORMA_PREVIEW_PORT: String(port),
          FORMA_PREVIEW_CACHE_DIR: warmupPlan.cacheDir,
          FORMA_PREVIEW_OPTIMIZE_DEPS_ENTRIES: JSON.stringify(warmupPlan.optimizeDepsEntries),
          FORMA_PREVIEW_WARMUP_FILES: JSON.stringify(warmupPlan.warmupFiles),
          FORMA_PREVIEW_MODULE_MOCKS: JSON.stringify(
            Object.fromEntries(
              Object.entries(target.moduleMocks).map(([find, replacement]) => [
                find,
                path.join(project.workspaceRoot, replacement),
              ]),
            ),
          ),
          FORMA_PREVIEW_ALIASES: JSON.stringify(target.aliasEntries),
          FORMA_PREVIEW_REACT_ALIASES: JSON.stringify(reactAliases),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.stdout || !child.stderr) {
        yield* stopRuntimeRecord({
          projectId: project.id,
          relativePath: target.relativePath,
          previewFileRelativePath: target.previewFileRelativePath,
          runtimeDir,
          cacheDir: warmupPlan.cacheDir,
          port,
          baseUrl: `http://${PREVIEW_RUNTIME_HOST}:${port}`,
          iframeBasePath: `/__preview/${project.id}`,
          child: child as ChildProcessByStdio<null, Readable, Readable>,
          logs: [],
          readinessPaths: warmupPlan.readinessPaths,
          startedAt: new Date().toISOString(),
          lastHealthCheckAt: null,
        });
        return yield* failPreview("Preview runtime did not expose stdout/stderr pipes.");
      }
      const runtimeChild = child as ChildProcessByStdio<null, Readable, Readable>;

      const logs: string[] = [];
      const captureLogs = (chunk: Buffer) => {
        logs.push(chunk.toString("utf8"));
        if (logs.length > 20) {
          logs.shift();
        }
      };
      runtimeChild.stdout.on("data", captureLogs);
      runtimeChild.stderr.on("data", captureLogs);

      const runtimeRecord: RuntimeRecord = {
        projectId: project.id,
        relativePath: target.relativePath,
        previewFileRelativePath: target.previewFileRelativePath,
        runtimeDir,
        cacheDir: warmupPlan.cacheDir,
        port,
        baseUrl: `http://${PREVIEW_RUNTIME_HOST}:${port}`,
        iframeBasePath: `/__preview/${project.id}`,
        child: runtimeChild,
        logs,
        readinessPaths: warmupPlan.readinessPaths,
        startedAt: new Date().toISOString(),
        lastHealthCheckAt: null,
      };

      runtimeChild.once("exit", () => {
        void Effect.runPromise(
          Ref.update(stateRef, (state) => {
            const activeRuntime = state.runtimes.get(project.id);
            if (!activeRuntime || activeRuntime.child !== runtimeChild) {
              return state;
            }
            const nextRuntimes = new Map(state.runtimes);
            nextRuntimes.delete(project.id);
            return { ...state, runtimes: nextRuntimes };
          }).pipe(
            Effect.andThen(
              publishProjectEvent(project.id, { kind: "runtime.stopped", projectId: project.id }),
            ),
            Effect.catch(() => Effect.void),
          ),
        );
      });

      yield* Effect.tryPromise({
        try: async () => {
          await waitForRuntimeReady(runtimeRecord.baseUrl, 30_000, runtimeRecord.readinessPaths);
        },
        catch: (cause) => {
          const lastLogs = logs.join("\n").trim();
          const baseMessage =
            cause instanceof Error ? cause.message : "Failed to start preview harness runtime.";
          return toPreviewError(lastLogs ? `${baseMessage}\n\n${lastLogs}` : baseMessage, cause);
        },
      }).pipe(
        Effect.tapError((error) =>
          publishProjectEvent(project.id, {
            kind: "runtime.error",
            projectId: project.id,
            message: error.message,
          }),
        ),
      );

      yield* Ref.update(stateRef, (state) => ({
        ...state,
        runtimes: new Map(state.runtimes).set(project.id, runtimeRecord),
      }));
      yield* publishProjectEvent(project.id, {
        kind: "runtime.ready",
        projectId: project.id,
        iframeBasePath: runtimeRecord.iframeBasePath,
      });

      return {
        projectId: project.id,
        provider: "componentHarness",
        started: true,
        iframeBasePath: runtimeRecord.iframeBasePath,
      } satisfies PreviewEnsureRuntimeResult;
    });

  const resolveTarget: PreviewManagerShape["resolveTarget"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const relativePath = normalizeProjectPath(input.relativePath);
      const absolutePath = path.join(project.workspaceRoot, relativePath);
      const exists = yield* Effect.tryPromise({
        try: () => pathExists(absolutePath),
        catch: (cause) => toPreviewError("Failed to resolve the selected preview target.", cause),
      });
      if (!exists) {
        return {
          status: "notFound",
          relativePath: asProjectRelativePath(relativePath),
        } satisfies PreviewResolveTargetResult;
      }
      if (!isComponentPath(relativePath)) {
        return {
          status: "unsupportedTarget",
          relativePath: asProjectRelativePath(relativePath),
          reason: "Only component source files can be previewed.",
        } satisfies PreviewResolveTargetResult;
      }

      const framework = yield* Effect.tryPromise({
        try: () => detectProjectFramework(project.workspaceRoot, relativePath),
        catch: (cause) => toPreviewError("Failed to detect the preview framework.", cause),
      });
      if (framework === "unsupported") {
        return {
          status: "unsupportedTarget",
          relativePath: asProjectRelativePath(relativePath),
          reason: "Forma preview harness currently supports React-family repos only.",
        } satisfies PreviewResolveTargetResult;
      }

      const workspaceRootRelativePath = yield* Effect.tryPromise({
        try: () => resolveWorkspaceRootRelativePath(project.workspaceRoot, relativePath),
        catch: (cause) =>
          toPreviewError("Failed to resolve the owning workspace for this preview target.", cause),
      });
      const workspaceRecord = getWorkspaceRecord(project, workspaceRootRelativePath);

      const bootstrapReady = yield* Effect.tryPromise({
        try: () => hasBootstrapFiles(project.workspaceRoot),
        catch: (cause) => toPreviewError("Failed to inspect preview bootstrap files.", cause),
      });
      if (!bootstrapReady) {
        return {
          status: "needsBootstrap",
          relativePath: asProjectRelativePath(relativePath),
          workspaceRootRelativePath,
          existingThreadId: workspaceRecord?.threadId ?? null,
          reason: "Repo-level preview bootstrap files are missing under .forma/preview/.",
        } satisfies PreviewResolveTargetResult;
      }

      const previewFileRelativePath = previewFilePathForComponent(relativePath);
      if (
        !(yield* Effect.tryPromise({
          try: () => pathExists(path.join(project.workspaceRoot, previewFileRelativePath)),
          catch: (cause) => toPreviewError("Failed to inspect component preview files.", cause),
        }))
      ) {
        return {
          status: "needsGeneration",
          relativePath: asProjectRelativePath(relativePath),
          workspaceRootRelativePath,
          threadId: workspaceRecord?.threadId ?? null,
          previewFileRelativePath: asProjectRelativePath(previewFileRelativePath),
          reason: "This component does not have a preview file yet.",
        } satisfies PreviewResolveTargetResult;
      }

      const previewFileInspection = yield* Effect.tryPromise({
        try: () => inspectPreviewFile(project.workspaceRoot, previewFileRelativePath),
        catch: (cause) => toPreviewError("Failed to inspect the component preview file.", cause),
      });
      const aliasEntries = yield* Effect.tryPromise({
        try: () =>
          inferAliasEntries(project.workspaceRoot, relativePath, workspaceRootRelativePath),
        catch: (cause) => toPreviewError("Failed to infer project import aliases.", cause),
      });
      const targetRecord: ResolvedHarnessTarget = {
        projectId: project.id,
        relativePath,
        previewFileRelativePath,
        workspaceRootRelativePath,
        framework,
        scenarioChoices: previewFileInspection.scenarioChoices,
        initialScenarioId: previewFileInspection.initialScenarioId,
        moduleMocks: previewFileInspection.moduleMocks,
        aliasEntries,
        previewComponentRelativePath: previewFileInspection.previewComponentRelativePath,
      };
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        lastResolvedTargets: new Map(state.lastResolvedTargets).set(project.id, targetRecord),
      }));

      const runtimeExit = yield* Effect.exit(startRuntimeForTarget(project, targetRecord));
      if (!Exit.isSuccess(runtimeExit)) {
        const runtimeFailure = Cause.squash(runtimeExit.cause);
        const runtimeMessage =
          runtimeFailure instanceof Error ? runtimeFailure.message : String(runtimeFailure);
        yield* persistWorkspaceRecord(project, {
          workspaceRootRelativePath,
          status: "failed",
          lastPreviewFileRelativePath: previewFileRelativePath,
          lastError: runtimeMessage,
        });
        return {
          status: "runtimeError",
          relativePath: asProjectRelativePath(relativePath),
          workspaceRootRelativePath,
          threadId: workspaceRecord?.threadId ?? null,
          previewFileRelativePath: asProjectRelativePath(previewFileRelativePath),
          message: runtimeMessage,
        } satisfies PreviewResolveTargetResult;
      }

      yield* persistWorkspaceRecord(project, {
        workspaceRootRelativePath,
        status: "ready",
        lastPreviewFileRelativePath: previewFileRelativePath,
        lastError: null,
      });

      const runtime = runtimeExit.value;
      const runtimeTarget = (yield* Ref.get(stateRef)).runtimes.get(project.id);
      if (!runtimeTarget) {
        return yield* failPreview("Preview runtime was not available after startup.");
      }
      return {
        status: "resolved",
        relativePath: asProjectRelativePath(relativePath),
        previewFileRelativePath: asProjectRelativePath(previewFileRelativePath),
        iframePath: `${runtime.iframeBasePath}/preview.html`,
        directIframeUrl: `${runtimeTarget.baseUrl}/preview.html`,
        initialScenarioId: previewFileInspection.initialScenarioId,
        scenarioChoices: [...previewFileInspection.scenarioChoices],
      } satisfies PreviewResolveTargetResult;
    });

  const prepareBootstrapThread: PreviewManagerShape["prepareBootstrapThread"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const relativePath = normalizeProjectPath(input.relativePath);
      const workspaceRootRelativePath = yield* Effect.tryPromise({
        try: () => resolveWorkspaceRootRelativePath(project.workspaceRoot, relativePath),
        catch: (cause) =>
          toPreviewError("Failed to resolve the owning workspace for this preview target.", cause),
      });
      const workspaceRecord = getWorkspaceRecord(project, workspaceRootRelativePath);
      const framework = yield* Effect.tryPromise({
        try: () => detectProjectFramework(project.workspaceRoot, relativePath),
        catch: (cause) => toPreviewError("Failed to detect the preview framework.", cause),
      });
      return {
        workspaceRootRelativePath,
        existingThreadId: workspaceRecord?.threadId ?? null,
        threadTitle: buildThreadTitle(workspaceRootRelativePath),
        initialPrompt: buildBootstrapPrompt({
          project,
          framework,
          workspaceRootRelativePath,
          relativePath,
        }),
        inspectionSummary: `Set up repo-level preview bootstrap files for ${workspaceLabel(workspaceRootRelativePath)}.`,
        reviewSummary: [
          `Selected component: ${relativePath}`,
          `Owner workspace: ${workspaceLabel(workspaceRootRelativePath)}`,
          `Bootstrap files: ${BOOTSTRAP_FILE_PATHS.join(", ")}`,
        ],
      } satisfies PreviewPrepareBootstrapThreadResult;
    });

  const preparePreviewGenerationTurn: PreviewManagerShape["preparePreviewGenerationTurn"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const relativePath = normalizeProjectPath(input.relativePath);
      const workspaceRootRelativePath = yield* Effect.tryPromise({
        try: () => resolveWorkspaceRootRelativePath(project.workspaceRoot, relativePath),
        catch: (cause) =>
          toPreviewError("Failed to resolve the owning workspace for this preview target.", cause),
      });
      const workspaceRecord = getWorkspaceRecord(project, workspaceRootRelativePath);
      const previewFileRelativePath = previewFilePathForComponent(relativePath);
      return {
        workspaceRootRelativePath,
        threadId: workspaceRecord?.threadId ?? null,
        turnPrompt: buildPreviewGenerationPrompt({
          relativePath,
          previewFileRelativePath,
        }),
        previewFileRelativePath: asProjectRelativePath(previewFileRelativePath),
      } satisfies PreviewPreparePreviewGenerationTurnResult;
    });

  const preparePreviewRepairTurn: PreviewManagerShape["preparePreviewRepairTurn"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const relativePath = normalizeProjectPath(input.relativePath);
      const workspaceRootRelativePath = yield* Effect.tryPromise({
        try: () => resolveWorkspaceRootRelativePath(project.workspaceRoot, relativePath),
        catch: (cause) =>
          toPreviewError("Failed to resolve the owning workspace for this preview target.", cause),
      });
      const workspaceRecord = getWorkspaceRecord(project, workspaceRootRelativePath);
      return {
        workspaceRootRelativePath,
        threadId: workspaceRecord?.threadId ?? null,
        turnPrompt: buildPreviewRepairPrompt({
          relativePath,
          previewFileRelativePath: input.previewFileRelativePath,
          errorMessage: input.errorMessage,
        }),
        previewFileRelativePath: input.previewFileRelativePath,
      } satisfies PreviewPreparePreviewRepairTurnResult;
    });

  const ensureRuntime: PreviewManagerShape["ensureRuntime"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const existingRuntime = (yield* Ref.get(stateRef)).runtimes.get(project.id);
      if (
        existingRuntime &&
        (yield* Effect.promise(() =>
          isRuntimeReady(existingRuntime.baseUrl, existingRuntime.readinessPaths),
        ))
      ) {
        return {
          projectId: project.id,
          provider: "componentHarness",
          started: false,
          iframeBasePath: existingRuntime.iframeBasePath,
        } satisfies PreviewEnsureRuntimeResult;
      }
      const lastTarget = (yield* Ref.get(stateRef)).lastResolvedTargets.get(project.id);
      if (!lastTarget) {
        return yield* failPreview("No preview target has been resolved yet for this project.");
      }
      return yield* startRuntimeForTarget(project, lastTarget);
    });

  const stopRuntime: PreviewManagerShape["stopRuntime"] = (input) =>
    Effect.gen(function* () {
      const runtime = (yield* Ref.get(stateRef)).runtimes.get(input.projectId);
      if (!runtime) return;
      yield* stopRuntimeRecord(runtime);
      yield* Ref.update(stateRef, (state) => {
        const next = new Map(state.runtimes);
        next.delete(input.projectId);
        return { ...state, runtimes: next };
      });
      yield* publishProjectEvent(input.projectId, {
        kind: "runtime.stopped",
        projectId: input.projectId,
      });
    });

  const issueAccessToken: PreviewManagerShape["issueAccessToken"] = (input) =>
    Effect.gen(function* () {
      yield* getProjectById(input.projectId);
      return yield* issueAccessTokenForProject(input.projectId);
    });

  const streamProject: PreviewManagerShape["streamProject"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const pubsub = yield* ensureProjectPubSub(input.projectId);
        return Stream.fromPubSub(pubsub);
      }).pipe(
        Effect.mapError((cause) =>
          toPreviewError("Failed to subscribe to preview project events.", cause),
        ),
      ),
    );

  const getRuntimeTarget: PreviewManagerShape["getRuntimeTarget"] = (projectId) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const runtime = state.runtimes.get(projectId);
        if (!runtime) return null;
        return {
          projectId,
          baseUrl: runtime.baseUrl,
        } satisfies PreviewRuntimeTarget;
      }),
    );

  const authenticateAccessToken: PreviewManagerShape["authenticateAccessToken"] = (
    projectId,
    accessToken,
  ) =>
    Ref.modify(stateRef, (state) => {
      const nextTokens = pruneExpiredAccessTokens(state);
      const record = nextTokens.get(accessToken);
      return [
        Boolean(record && record.projectId === projectId),
        {
          ...state,
          accessTokens: nextTokens,
        },
      ] as const;
    });

  yield* Effect.addFinalizer(() =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        Effect.forEach(state.runtimes.values(), (runtime) => stopRuntimeRecord(runtime), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );

  return {
    inspectProject,
    searchComponents,
    resolveTarget,
    prepareBootstrapThread,
    preparePreviewGenerationTurn,
    preparePreviewRepairTurn,
    ensureRuntime,
    issueAccessToken,
    stopRuntime,
    streamProject,
    getRuntimeTarget,
    authenticateAccessToken,
  } satisfies PreviewManagerShape;
});

export const PreviewManagerLive = Layer.effect(PreviewManager, makePreviewManager);
