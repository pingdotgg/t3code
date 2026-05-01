import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  CommandId,
  type PreviewControlsBridgeStatus,
  type PreviewEnsureRuntimeResult,
  type PreviewIssueAccessTokenResult,
  type PreviewPrepareStoryWorkTurnResult,
  type PreviewPrepareWorkspaceSetupThreadResult,
  type PreviewProjectEvent,
  type PreviewProjectInspectionResult,
  type PreviewResolveTargetResult,
  type PreviewSearchComponentsResult,
  PreviewRpcError,
  type PreviewStoryWorkAction,
  type PreviewTargetKind,
  type ProjectId,
  type ProjectPreviewConfig,
  type ProjectPreviewWorkspaceRecord,
  ProjectRelativePath,
} from "@forma/contracts";
import { Cause, Deferred, Effect, Exit, Layer, PubSub, Ref, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  PreviewManager,
  type PreviewManagerShape,
  type PreviewRuntimeTarget,
} from "../Services/PreviewManager.ts";

interface ProjectRecord {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly previewConfig: ProjectPreviewConfig | null | undefined;
  readonly previewWorkspaceRecords: readonly ProjectPreviewWorkspaceRecord[];
}

interface StorybookIndexEntry {
  readonly id: string;
  readonly importPath?: string;
  readonly title?: string;
  readonly name?: string;
  readonly type?: string;
}

interface StorybookWorkspace {
  readonly workspaceRootRelativePath: string;
  readonly storybookConfigPaths: readonly string[];
  readonly mainConfigPath: string | null;
  readonly commandCandidates: readonly string[];
  readonly controlsBridgeStatus: PreviewControlsBridgeStatus;
  readonly coverageStatus: "proven" | "unproven";
  readonly resolvedStoryGlobs: readonly string[];
}

interface PackageWorkspace {
  readonly workspaceRootRelativePath: string;
  readonly packageJsonPath: string;
  readonly packageJson: PackageJsonRecord | null;
  readonly framework: string | null;
}

interface RuntimeRecord {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly command: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly iframeBasePath: string;
  readonly child: ChildProcess;
}

interface PackageJsonRecord {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface PreviewAccessTokenRecord {
  readonly token: string;
  readonly projectId: ProjectId;
  readonly expiresAtMs: number;
}

interface PreviewManagerState {
  readonly runtimes: Map<ProjectId, RuntimeRecord>;
  readonly runtimeStarts: Map<
    ProjectId,
    Deferred.Deferred<PreviewEnsureRuntimeResult, PreviewRpcError>
  >;
  readonly projectPubSubs: Map<ProjectId, PubSub.PubSub<PreviewProjectEvent>>;
  readonly accessTokens: Map<string, PreviewAccessTokenRecord>;
}

interface StorybookInspectionDetails {
  readonly framework: string | null;
  readonly packageManager: "bun" | "pnpm" | "yarn" | "npm";
  readonly storybookConfigPaths: readonly string[];
  readonly detectedStartCommands: readonly string[];
  readonly controlsBridgeStatus: PreviewControlsBridgeStatus;
  readonly hasStorybookSetup: boolean;
  readonly workspaces: readonly StorybookWorkspace[];
}

const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "storybook-static",
]);
const COMPONENT_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".ts", ".js"]);
const STORYBOOK_MAIN_CONFIG_CANDIDATES = [
  ".storybook/main.ts",
  ".storybook/main.tsx",
  ".storybook/main.js",
  ".storybook/main.jsx",
  ".storybook/main.mjs",
  ".storybook/main.cjs",
];
const STORYBOOK_BRIDGE_RELATIVE_PATH = ".forma/storybook/previewBridge.js";
const PREVIEW_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const PREVIEW_RUNTIME_HOST = "127.0.0.1";

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

function isStoryPath(relativePath: string): boolean {
  return /\.(stories|story)\.[^.]+$/i.test(relativePath);
}

function isComponentPath(relativePath: string): boolean {
  const normalized = normalizeProjectPath(relativePath);
  if (!COMPONENT_EXTENSIONS.has(path.extname(normalized))) return false;
  if (normalized.endsWith(".d.ts")) return false;
  if (isStoryPath(normalized)) return false;
  return !/(\.test|\.spec)\.[^.]+$/i.test(normalized);
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

async function detectPackageManager(cwd: string): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
  if (await pathExists(path.join(cwd, "bun.lock"))) return "bun";
  if (await pathExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function resolveFramework(pkg: PackageJsonRecord | null): string | null {
  const dependencies = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
  };
  if ("next" in dependencies) return "nextjs";
  if ("vue" in dependencies) return "vue";
  if ("react" in dependencies) return "react";
  return null;
}

function detectStorybookConfigPaths(files: readonly string[]): string[] {
  return files.filter((file) => /(^|\/)\.storybook\//.test(file));
}

function scriptCommandPrefix(packageManager: "bun" | "pnpm" | "yarn" | "npm"): string {
  if (packageManager === "bun") return "bun run";
  if (packageManager === "pnpm") return "pnpm run";
  if (packageManager === "yarn") return "yarn";
  return "npm run";
}

function buildScopedScriptCommand(
  packageManager: "bun" | "pnpm" | "yarn" | "npm",
  scriptName: string,
  workspaceRootRelativePath?: string,
): string {
  const normalizedWorkspace = normalizeProjectPath(workspaceRootRelativePath ?? "");
  if (!normalizedWorkspace || normalizedWorkspace === ".") {
    return `${scriptCommandPrefix(packageManager)} ${scriptName}`;
  }
  const quotedWorkspace = JSON.stringify(normalizedWorkspace);
  if (packageManager === "pnpm") {
    return `pnpm --dir ${quotedWorkspace} run ${scriptName}`;
  }
  if (packageManager === "bun") {
    return `bun run --cwd ${quotedWorkspace} ${scriptName}`;
  }
  if (packageManager === "yarn") {
    return `yarn --cwd ${quotedWorkspace} ${scriptName}`;
  }
  return `npm --prefix ${quotedWorkspace} run ${scriptName}`;
}

function buildScopedExecutableCommand(
  packageManager: "bun" | "pnpm" | "yarn" | "npm",
  executableCommand: string,
  workspaceRootRelativePath?: string,
): string {
  const normalizedWorkspace = normalizeProjectPath(workspaceRootRelativePath ?? "");
  const quotedWorkspace = JSON.stringify(normalizedWorkspace || ".");
  if (!normalizedWorkspace || normalizedWorkspace === ".") {
    if (packageManager === "pnpm") return `pnpm exec ${executableCommand}`;
    if (packageManager === "bun") return `bun x ${executableCommand}`;
    if (packageManager === "yarn") return `yarn exec ${executableCommand}`;
    return `npm exec -- ${executableCommand}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm --dir ${quotedWorkspace} exec ${executableCommand}`;
  }
  if (packageManager === "bun") {
    return `cd ${quotedWorkspace} && bun x ${executableCommand}`;
  }
  if (packageManager === "yarn") {
    return `yarn --cwd ${quotedWorkspace} exec ${executableCommand}`;
  }
  return `npm --prefix ${quotedWorkspace} exec -- ${executableCommand}`;
}

function isScriptRunnerCommand(command: string): boolean {
  return (
    /^(npm|pnpm|bun)\b[\s\S]*\brun\b/.test(command) ||
    /^yarn\b[\s\S]*(?:\bexec\b)?[\s\S]*\S+/.test(command)
  );
}

function appendScriptRunnerArgs(command: string, args: readonly string[]): string {
  if (args.length === 0) {
    return command;
  }
  if (/^npm\b/.test(command)) {
    return command.includes(" -- ")
      ? `${command} ${args.join(" ")}`
      : `${command} -- ${args.join(" ")}`;
  }
  if (/^(pnpm|bun|yarn)\b/.test(command)) {
    return `${command} ${args.join(" ")}`;
  }
  return `${command} ${args.join(" ")}`;
}

function buildStorybookRuntimeCommandCandidate(
  packageManager: "bun" | "pnpm" | "yarn" | "npm",
  scriptName: string,
  scriptCommand: string,
  workspaceRootRelativePath?: string,
): string {
  if (/^\s*(?:storybook|start-storybook)\b/i.test(scriptCommand)) {
    return buildScopedExecutableCommand(
      packageManager,
      scriptCommand.trim(),
      workspaceRootRelativePath,
    );
  }
  return buildScopedScriptCommand(packageManager, scriptName, workspaceRootRelativePath);
}

function isStorybookBuildLikeScript(scriptName: string, command: string): boolean {
  return (
    /\bbuild\b/i.test(scriptName) ||
    /\bstatic\b/i.test(scriptName) ||
    /(?:^|:)run$/i.test(scriptName) ||
    /\bstorybook\s+build\b/i.test(command) ||
    /\bbuild-storybook\b/i.test(command) ||
    /\bserve\b/i.test(command)
  );
}

function detectStorybookCommandCandidates(
  pkg: PackageJsonRecord | null,
  packageManager: "bun" | "pnpm" | "yarn" | "npm",
  workspaceRootRelativePath?: string,
): string[] {
  const scripts = pkg?.scripts ?? {};
  const scriptEntries = Object.entries(scripts).filter(
    ([name, command]) =>
      !isStorybookBuildLikeScript(name, command) &&
      (/storybook/i.test(name) || /\bstorybook\b/i.test(command)),
  );
  const preferredEntries = scriptEntries.some(([name]) => /storybook/i.test(name))
    ? scriptEntries.filter(([name]) => /storybook/i.test(name))
    : scriptEntries;
  const candidates = preferredEntries.map(([name, command]) =>
    buildStorybookRuntimeCommandCandidate(packageManager, name, command, workspaceRootRelativePath),
  );
  return [...new Set(candidates)].toSorted((left, right) => {
    const leftScore = /\bstorybook$/.test(left) ? 0 : 1;
    const rightScore = /\bstorybook$/.test(right) ? 0 : 1;
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.localeCompare(right);
  });
}

function detectStorybookMainConfigPath(files: readonly string[]): string | null {
  for (const candidate of STORYBOOK_MAIN_CONFIG_CANDIDATES) {
    const match = files.find((file) => file.endsWith(candidate));
    if (match) {
      return match;
    }
  }
  return null;
}

function workspaceRootFromStorybookConfig(storybookConfigPath: string): string {
  const normalized = normalizeProjectPath(storybookConfigPath);
  const marker = "/.storybook/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }
  return normalized.slice(0, markerIndex);
}

function normalizeStorybookImportPath(importPath: string): string {
  return normalizeProjectPath(importPath).replace(/^\.\/+/, "");
}

function withConfiguredPort(command: string, port: number): string {
  if (/(^|\s)--port(?:=|\s+)\d+/.test(command)) {
    return command.replace(/(^|\s)--port(?:=|\s+)\d+/, `$1--port ${port}`);
  }
  if (/(^|\s)-p\s+\d+/.test(command)) {
    return command.replace(/(^|\s)-p\s+\d+/, `$1-p ${port}`);
  }
  if (/^(npm|pnpm|bun)\b[\s\S]*\bexec\b[\s\S]*\bstorybook\b/.test(command)) {
    return `${command} --port ${port}`;
  }
  if (isScriptRunnerCommand(command)) {
    return appendScriptRunnerArgs(command, [`--port ${port}`]);
  }
  return `${command} --port ${port}`;
}

function withConfiguredHost(command: string, host: string): string {
  if (/(^|\s)--host(?:=|\s+)\S+/.test(command)) {
    return command.replace(/(^|\s)--host(?:=|\s+)\S+/, `$1--host ${host}`);
  }
  if (/^(npm|pnpm|bun)\b[\s\S]*\bexec\b[\s\S]*\bstorybook\b/.test(command)) {
    return `${command} --host ${host}`;
  }
  if (isScriptRunnerCommand(command)) {
    return appendScriptRunnerArgs(command, [`--host ${host}`]);
  }
  return `${command} --host ${host}`;
}

function withConfiguredCi(command: string): string {
  if (/(^|\s)--ci(?:\s|$)/.test(command)) {
    return command;
  }
  if (/^(npm|pnpm|bun)\b[\s\S]*\bexec\b[\s\S]*\bstorybook\b/.test(command)) {
    return `${command} --ci`;
  }
  if (isScriptRunnerCommand(command)) {
    return appendScriptRunnerArgs(command, ["--ci"]);
  }
  return `${command} --ci`;
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate preview port."));
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
    server.on("error", reject);
  });
}

async function waitForStorybookReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/index.json`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for Storybook preview runtime.");
}

async function isStorybookReady(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    await waitForStorybookReady(baseUrl, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function loadStorybookEntries(baseUrl: string): Promise<StorybookIndexEntry[]> {
  const response = await fetch(`${baseUrl}/index.json`);
  if (!response.ok) {
    throw new Error(`Failed to load Storybook index (${response.status}).`);
  }
  const json = (await response.json()) as
    | {
        entries?: Record<string, StorybookIndexEntry>;
        stories?: Record<string, StorybookIndexEntry>;
      }
    | undefined;
  const entries = json?.entries ?? json?.stories ?? {};
  return Object.values(entries);
}

function buildPreviewConfig(
  current: ProjectPreviewConfig | null | undefined,
  patch: {
    readonly workspaceCommandOverrides?: Record<string, string> | undefined;
    readonly componentStoryMappings?: Record<string, string> | undefined;
  },
): ProjectPreviewConfig {
  return {
    provider: "storybook",
    workspaceCommandOverrides: {
      ...current?.workspaceCommandOverrides,
      ...patch.workspaceCommandOverrides,
    },
    startCommandOverride: current?.startCommandOverride ?? null,
    componentStoryMappings: {
      ...current?.componentStoryMappings,
      ...patch.componentStoryMappings,
    },
  };
}

function getWorkspaceCommandOverride(
  previewConfig: ProjectPreviewConfig | null | undefined,
  workspaceRootRelativePath: string,
): string | null {
  const normalizedWorkspaceRoot = normalizeProjectPath(workspaceRootRelativePath);
  return (
    previewConfig?.workspaceCommandOverrides?.[normalizedWorkspaceRoot] ??
    previewConfig?.startCommandOverride ??
    null
  );
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

async function inferStoryCandidates(cwd: string, componentRelativePath: string): Promise<string[]> {
  const files = await listRelativeFiles(cwd);
  const normalizedComponentPath = normalizeProjectPath(componentRelativePath);
  const dirname = path.posix.dirname(normalizedComponentPath);
  const basename = path.basename(normalizedComponentPath, path.extname(normalizedComponentPath));
  const storyFiles = files.filter(isStoryPath);
  const colocated = storyFiles.filter((file) => {
    if (path.posix.dirname(file) !== dirname) return false;
    const stem = path.basename(file).replace(/\.(stories|story)\.[^.]+$/i, "");
    return stem === basename;
  });
  if (colocated.length > 0) return colocated;
  return storyFiles.filter((file) => {
    const stem = path.basename(file).replace(/\.(stories|story)\.[^.]+$/i, "");
    return stem === basename;
  });
}

function storyFilePathForComponent(componentRelativePath: string): string {
  const normalized = normalizeProjectPath(componentRelativePath);
  const extension = path.extname(normalized);
  const base = normalized.slice(0, -extension.length);
  if (extension === ".jsx" || extension === ".js") {
    return `${base}.stories.jsx`;
  }
  return `${base}.stories.tsx`;
}

function storybookBridgeImportPathForWorkspaceRoot(workspaceRootRelativePath: string): string {
  const normalizedWorkspaceRoot = normalizeProjectPath(workspaceRootRelativePath);
  const relativeImportPath = normalizedWorkspaceRoot
    ? path.posix.relative(normalizedWorkspaceRoot, STORYBOOK_BRIDGE_RELATIVE_PATH)
    : STORYBOOK_BRIDGE_RELATIVE_PATH;
  return normalizeProjectPath(relativeImportPath || STORYBOOK_BRIDGE_RELATIVE_PATH);
}

function patchStorybookMainConfigWithBridge(
  existingContents: string,
  workspaceRootRelativePath: string,
):
  | { kind: "patched"; contents: string; changed: boolean }
  | { kind: "manualRequired"; reason: string } {
  const bridgeImportPath = storybookBridgeImportPathForWorkspaceRoot(workspaceRootRelativePath);
  if (existingContents.includes(bridgeImportPath)) {
    return { kind: "patched", contents: existingContents, changed: false };
  }
  if (existingContents.includes("previewBridge.js")) {
    return {
      kind: "patched",
      contents: existingContents.replaceAll(
        /(["'`])([^"'`\n]*previewBridge\.js)\1/g,
        `$1${bridgeImportPath}$1`,
      ),
      changed: true,
    };
  }

  if (/previewAnnotations\s*:/.test(existingContents)) {
    const previewAnnotationsArrayMatch = existingContents.match(
      /previewAnnotations\s*:\s*\[([\s\S]*?)\]/m,
    );
    if (!previewAnnotationsArrayMatch || previewAnnotationsArrayMatch.index === undefined) {
      return {
        kind: "manualRequired",
        reason:
          "Forma could not safely update .storybook/main.* because previewAnnotations uses a non-array expression.",
      };
    }
    const nextContents = existingContents.replace(
      /previewAnnotations\s*:\s*\[([\s\S]*?)\]/m,
      (_match, body: string) => {
        const trimmedBody = body.trim();
        const insertion =
          trimmedBody.length === 0
            ? `previewAnnotations: ["${bridgeImportPath}"]`
            : `previewAnnotations: [${body.replace(/\s*$/, "")}, "${bridgeImportPath}"]`;
        return insertion;
      },
    );
    return { kind: "patched", contents: nextContents, changed: true };
  }

  const objectOpenPatterns = [
    /^(\s*)export\s+default\s*{/m,
    /^(\s*)module\.exports\s*=\s*{/m,
    /^(\s*)(?:const|let|var)\s+\w+(?::[^=]+)?\s*=\s*{/m,
  ];
  for (const pattern of objectOpenPatterns) {
    const match = pattern.exec(existingContents);
    if (!match || match.index === undefined) continue;
    const indent = match[1] ?? "";
    const matchedText = match[0];
    const nextContents = `${existingContents.slice(0, match.index)}${matchedText}
${indent}  previewAnnotations: ["${bridgeImportPath}"],${existingContents.slice(
      match.index + matchedText.length,
    )}`;
    return { kind: "patched", contents: nextContents, changed: true };
  }

  return {
    kind: "manualRequired",
    reason:
      "Forma could not safely update .storybook/main.* because the exported Storybook config shape is unsupported.",
  };
}

function buildControlsBridgeInspection(
  files: readonly string[],
  mainConfigContents: string | null,
  workspaceRootRelativePath: string,
) {
  const bridgeImportPath = storybookBridgeImportPathForWorkspaceRoot(workspaceRootRelativePath);
  if (!detectStorybookMainConfigPath(files)) {
    return "manualRequired" as const;
  }
  if (mainConfigContents && mainConfigContents.includes(bridgeImportPath)) {
    return "installed" as const;
  }
  if (!mainConfigContents) {
    return "manualRequired" as const;
  }
  const patchAttempt = patchStorybookMainConfigWithBridge(
    mainConfigContents,
    workspaceRootRelativePath,
  );
  return patchAttempt.kind === "patched" ? "missing" : "manualRequired";
}

function resolveCombinedControlsBridgeStatus(
  workspaces: readonly StorybookWorkspace[],
): PreviewControlsBridgeStatus {
  if (workspaces.length === 0) {
    return "missing";
  }
  if (workspaces.some((workspace) => workspace.controlsBridgeStatus === "manualRequired")) {
    return "manualRequired";
  }
  if (workspaces.every((workspace) => workspace.controlsBridgeStatus === "installed")) {
    return "installed";
  }
  return "missing";
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function skipTrivia(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current && /\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index + 1 < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function readStaticStringLiteral(
  source: string,
  startIndex: number,
): { readonly value: string; readonly endIndex: number } | null {
  const quote = source[startIndex];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  let index = startIndex + 1;
  let value = "";
  while (index < source.length) {
    const current = source[index];
    if (current === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        return null;
      }
      value += escaped;
      index += 2;
      continue;
    }
    if (quote === "`" && current === "$" && source[index + 1] === "{") {
      return null;
    }
    if (current === quote) {
      return { value, endIndex: index + 1 };
    }
    value += current;
    index += 1;
  }
  return null;
}

function parseStaticStoriesValue(
  source: string,
  startIndex: number,
): { readonly values: readonly string[]; readonly endIndex: number } | null {
  const index = skipTrivia(source, startIndex);
  const current = source[index];
  if (current === undefined) {
    return null;
  }
  const stringLiteral = readStaticStringLiteral(source, index);
  if (stringLiteral) {
    return { values: [stringLiteral.value], endIndex: stringLiteral.endIndex };
  }
  if (current !== "[") {
    return null;
  }
  const values: string[] = [];
  let cursor = index + 1;
  while (cursor < source.length) {
    cursor = skipTrivia(source, cursor);
    const next = source[cursor];
    if (next === "]") {
      return { values, endIndex: cursor + 1 };
    }
    if (next === ",") {
      cursor += 1;
      continue;
    }
    if (source.startsWith("...", cursor)) {
      return null;
    }
    const nested = parseStaticStoriesValue(source, cursor);
    if (!nested) {
      return null;
    }
    values.push(...nested.values);
    cursor = skipTrivia(source, nested.endIndex);
    const separator = source[cursor];
    if (separator === ",") {
      cursor += 1;
      continue;
    }
    if (separator === "]") {
      return { values, endIndex: cursor + 1 };
    }
    return null;
  }
  return null;
}

function findStoriesPropertyValueStart(source: string): number | null {
  let index = 0;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (index >= source.length) {
      return null;
    }
    const current = source[index];
    if (current === '"' || current === "'" || current === "`") {
      const stringLiteral = readStaticStringLiteral(source, index);
      if (!stringLiteral) {
        return null;
      }
      const nextIndex = skipTrivia(source, stringLiteral.endIndex);
      if (stringLiteral.value === "stories" && source[nextIndex] === ":") {
        return nextIndex + 1;
      }
      index = stringLiteral.endIndex;
      continue;
    }
    if (
      source.startsWith("stories", index) &&
      !isIdentifierCharacter(source[index - 1]) &&
      !isIdentifierCharacter(source[index + "stories".length])
    ) {
      const nextIndex = skipTrivia(source, index + "stories".length);
      if (source[nextIndex] === ":") {
        return nextIndex + 1;
      }
      index += "stories".length;
      continue;
    }
    index += 1;
  }
  return null;
}

function resolveStaticStoryGlobsFromMainConfig(
  mainConfigPath: string,
  contents: string,
): readonly string[] | null {
  const storiesValueStart = findStoriesPropertyValueStart(contents);
  if (storiesValueStart === null) {
    return [];
  }
  const staticValues = parseStaticStoriesValue(contents, storiesValueStart);
  if (!staticValues) {
    return null;
  }
  const mainConfigDir = path.posix.dirname(normalizeProjectPath(mainConfigPath));
  return staticValues.values.map((value) =>
    normalizeProjectPath(
      value.startsWith("/") ? value : path.posix.normalize(path.posix.join(mainConfigDir, value)),
    ),
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    const next = glob[index + 1] ?? "";

    if (character === "*" && next === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
      continue;
    }
    if (character === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      continue;
    }
    if (character === "{") {
      const closeIndex = glob.indexOf("}", index + 1);
      if (closeIndex > index) {
        const body = glob.slice(index + 1, closeIndex);
        pattern += `(?:${body.split(",").map(escapeRegExp).join("|")})`;
        index = closeIndex;
        continue;
      }
    }
    if (character === "@" && next === "(") {
      const closeIndex = glob.indexOf(")", index + 2);
      if (closeIndex > index) {
        const body = glob.slice(index + 2, closeIndex);
        pattern += `(?:${body.split("|").map(escapeRegExp).join("|")})`;
        index = closeIndex;
        continue;
      }
    }
    if (character === "/") {
      pattern += "/";
      continue;
    }
    pattern += escapeRegExp(character);
  }
  pattern += "$";
  return new RegExp(pattern);
}

function storybookWorkspaceCoversPath(
  workspace: StorybookWorkspace,
  relativePath: string,
): boolean {
  if (workspace.coverageStatus !== "proven") {
    return false;
  }
  const normalizedPath = normalizeProjectPath(relativePath);
  return workspace.resolvedStoryGlobs.some((glob) => globToRegExp(glob).test(normalizedPath));
}

function pickCoveringStorybookWorkspaceForPath(
  workspaces: readonly StorybookWorkspace[],
  relativePath: string,
): StorybookWorkspace | null {
  return (
    workspaces
      .filter((workspace) => storybookWorkspaceCoversPath(workspace, relativePath))
      .toSorted(
        (left, right) =>
          right.workspaceRootRelativePath.length - left.workspaceRootRelativePath.length,
      )[0] ?? null
  );
}

async function discoverStorybookWorkspaces(
  cwd: string,
  files: readonly string[],
  packageManager: "bun" | "pnpm" | "yarn" | "npm",
): Promise<StorybookWorkspace[]> {
  const storybookConfigPaths = detectStorybookConfigPaths(files);
  const workspaceRootRelativePaths = [
    ...new Set(storybookConfigPaths.map(workspaceRootFromStorybookConfig)),
  ];
  const workspaces = await Promise.all(
    workspaceRootRelativePaths.map(async (workspaceRootRelativePath) => {
      const normalizedWorkspace = normalizeProjectPath(workspaceRootRelativePath);
      const workspaceFiles = files.filter((file) => {
        if (!normalizedWorkspace) {
          return true;
        }
        return file === normalizedWorkspace || file.startsWith(`${normalizedWorkspace}/`);
      });
      const packageJson = await readJsonFile<PackageJsonRecord>(
        path.join(cwd, normalizedWorkspace, "package.json"),
      );
      const mainConfigPath =
        workspaceFiles.find((file) =>
          STORYBOOK_MAIN_CONFIG_CANDIDATES.some((candidate) => file.endsWith(candidate)),
        ) ?? null;
      const mainConfigContents = mainConfigPath
        ? await readTextFile(path.join(cwd, mainConfigPath))
        : null;
      const resolvedStoryGlobs =
        mainConfigPath && mainConfigContents
          ? resolveStaticStoryGlobsFromMainConfig(mainConfigPath, mainConfigContents)
          : [];
      return {
        workspaceRootRelativePath: normalizedWorkspace,
        storybookConfigPaths: storybookConfigPaths.filter(
          (configPath) => workspaceRootFromStorybookConfig(configPath) === normalizedWorkspace,
        ),
        mainConfigPath,
        commandCandidates: detectStorybookCommandCandidates(
          packageJson,
          packageManager,
          normalizedWorkspace,
        ),
        controlsBridgeStatus: buildControlsBridgeInspection(
          workspaceFiles,
          mainConfigContents,
          normalizedWorkspace,
        ),
        coverageStatus: resolvedStoryGlobs === null ? "unproven" : "proven",
        resolvedStoryGlobs: resolvedStoryGlobs ?? [],
      } satisfies StorybookWorkspace;
    }),
  );

  return workspaces
    .filter(
      (workspace) =>
        workspace.storybookConfigPaths.length > 0 || workspace.commandCandidates.length > 0,
    )
    .toSorted((left, right) =>
      left.workspaceRootRelativePath.localeCompare(right.workspaceRootRelativePath),
    );
}

async function discoverPackageWorkspaces(
  cwd: string,
  files: readonly string[],
): Promise<PackageWorkspace[]> {
  const packageJsonPaths = files
    .filter(
      (file) => normalizeProjectPath(file) === "package.json" || file.endsWith("/package.json"),
    )
    .toSorted((left, right) => left.localeCompare(right));

  const workspaces = await Promise.all(
    packageJsonPaths.map(async (packageJsonPath) => {
      const normalizedPackageJsonPath = normalizeProjectPath(packageJsonPath);
      const workspaceRootRelativePath =
        normalizedPackageJsonPath === "package.json"
          ? ""
          : path.posix.dirname(normalizedPackageJsonPath);
      const packageJson = await readJsonFile<PackageJsonRecord>(
        path.join(cwd, normalizedPackageJsonPath),
      );
      return {
        workspaceRootRelativePath,
        packageJsonPath: normalizedPackageJsonPath,
        packageJson,
        framework: resolveFramework(packageJson),
      } satisfies PackageWorkspace;
    }),
  );

  return workspaces.toSorted((left, right) =>
    left.workspaceRootRelativePath.localeCompare(right.workspaceRootRelativePath),
  );
}

function pickPackageWorkspaceForPath(
  workspaces: readonly PackageWorkspace[],
  relativePath: string,
): PackageWorkspace | null {
  const normalizedPath = normalizeProjectPath(relativePath);
  return (
    workspaces
      .filter((workspace) => {
        const root = normalizeProjectPath(workspace.workspaceRootRelativePath);
        return !root || normalizedPath === root || normalizedPath.startsWith(`${root}/`);
      })
      .toSorted(
        (left, right) =>
          right.workspaceRootRelativePath.length - left.workspaceRootRelativePath.length,
      )[0] ?? null
  );
}

async function resolveOwnerWorkspaceForPath(
  cwd: string,
  relativePath: string,
): Promise<PackageWorkspace | null> {
  const files = await listRelativeFiles(cwd);
  const workspaces = await discoverPackageWorkspaces(cwd, files);
  const preferredWorkspace = pickPackageWorkspaceForPath(workspaces, relativePath);
  if (preferredWorkspace) {
    return preferredWorkspace;
  }
  const rootWorkspace =
    workspaces.find((workspace) => workspace.workspaceRootRelativePath.length === 0) ?? null;
  return rootWorkspace;
}

function resolveEffectivePreviewCommand(
  project: ProjectRecord,
  inspection: StorybookInspectionDetails,
  preferredWorkspaceRootRelativePath?: string | null,
): string | null {
  if (preferredWorkspaceRootRelativePath) {
    const workspaceOverride = getWorkspaceCommandOverride(
      project.previewConfig,
      preferredWorkspaceRootRelativePath,
    );
    if (workspaceOverride) {
      return workspaceOverride;
    }
    const preferredWorkspace = inspection.workspaces.find(
      (workspace) =>
        workspace.workspaceRootRelativePath ===
        normalizeProjectPath(preferredWorkspaceRootRelativePath),
    );
    if (preferredWorkspace?.commandCandidates.length === 1) {
      return preferredWorkspace.commandCandidates[0] ?? null;
    }
  }

  if (inspection.workspaces.length === 1) {
    const onlyWorkspace = inspection.workspaces[0]!;
    const onlyWorkspaceOverride = getWorkspaceCommandOverride(
      project.previewConfig,
      onlyWorkspace.workspaceRootRelativePath,
    );
    if (onlyWorkspaceOverride) {
      return onlyWorkspaceOverride;
    }
  }

  const rootWorkspaceOverride = getWorkspaceCommandOverride(project.previewConfig, "");
  if (rootWorkspaceOverride) {
    return rootWorkspaceOverride;
  }

  if (inspection.detectedStartCommands.length === 1) {
    return inspection.detectedStartCommands[0] ?? null;
  }

  return null;
}

async function inspectStorybookProject(cwd: string): Promise<StorybookInspectionDetails> {
  const packageJson = await readJsonFile<PackageJsonRecord>(path.join(cwd, "package.json"));
  const packageManager = await detectPackageManager(cwd);
  const files = await listRelativeFiles(cwd);
  const storybookConfigPaths = detectStorybookConfigPaths(files);
  const rootDetectedCommands = detectStorybookCommandCandidates(packageJson, packageManager);
  const workspaces = await discoverStorybookWorkspaces(cwd, files, packageManager);
  const workspaceCommands = workspaces.flatMap((workspace) => workspace.commandCandidates);
  const detectedStartCommands = [...new Set([...rootDetectedCommands, ...workspaceCommands])];
  const framework = resolveFramework(packageJson);
  const hasStorybookSetup = storybookConfigPaths.length > 0 || detectedStartCommands.length > 0;
  return {
    framework,
    packageManager,
    storybookConfigPaths,
    detectedStartCommands,
    controlsBridgeStatus: resolveCombinedControlsBridgeStatus(workspaces),
    hasStorybookSetup,
    workspaces,
  } satisfies StorybookInspectionDetails;
}

const makePreviewManager = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const stateRef = yield* Ref.make<PreviewManagerState>({
    runtimes: new Map(),
    runtimeStarts: new Map(),
    projectPubSubs: new Map(),
    accessTokens: new Map(),
  });
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const publishProjectEvent = (projectId: ProjectId, event: PreviewProjectEvent) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const pubsub = state.projectPubSubs.get(projectId);
      if (!pubsub) {
        return yield* failPreview("Project preview event stream is unavailable.");
      }
      yield* PubSub.publish(pubsub, event);
    });

  const ensureProjectPubSub = (projectId: ProjectId) =>
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

  const issueAccessTokenForProject = (projectId: ProjectId) =>
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

  const getProjectById = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const project = readModel.projects.find(
        (entry) => entry.id === projectId && entry.deletedAt === null,
      );
      if (!project) {
        return yield* failPreview(`Project '${projectId}' was not found.`);
      }
      return {
        ...project,
        previewConfig: project.previewConfig ?? null,
        previewWorkspaceRecords: project.previewWorkspaceRecords ?? [],
      } satisfies ProjectRecord;
    });

  const updateProjectPreviewMetadata = (
    project: ProjectRecord,
    patch: {
      readonly previewConfig?: ProjectPreviewConfig | null | undefined;
      readonly previewWorkspaceRecords?: readonly ProjectPreviewWorkspaceRecord[] | undefined;
    },
  ) =>
    orchestrationEngine
      .dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(`preview-meta:${crypto.randomUUID()}`),
        projectId: project.id,
        ...(patch.previewConfig !== undefined ? { previewConfig: patch.previewConfig } : {}),
        ...(patch.previewWorkspaceRecords !== undefined
          ? { previewWorkspaceRecords: [...patch.previewWorkspaceRecords] }
          : {}),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          toPreviewError("Failed to update preview project metadata.", cause),
        ),
      );

  const buildInspection = (project: ProjectRecord) =>
    Effect.tryPromise({
      try: async () => {
        const details = await inspectStorybookProject(project.workspaceRoot);
        const framework = details.framework;
        const hasStorybookSetup = details.hasStorybookSetup;
        const hasReact = framework === "react" || framework === "nextjs";
        const hasWorkspaceOverride =
          Object.keys(project.previewConfig?.workspaceCommandOverrides ?? {}).length > 0 ||
          project.previewConfig?.startCommandOverride !== null;
        const status =
          hasStorybookSetup && (hasWorkspaceOverride || details.detectedStartCommands.length === 1)
            ? "configured"
            : hasStorybookSetup
              ? "needsCommandOverride"
              : hasReact
                ? "enableable"
                : "unsupported";
        return {
          projectId: project.id,
          provider: "storybook",
          status,
          framework,
          detectedStartCommands: [...details.detectedStartCommands],
          storybookConfigPaths: details.storybookConfigPaths.map(asProjectRelativePath),
          packageManager: details.packageManager,
          controlsBridgeStatus: details.controlsBridgeStatus,
          summary:
            status === "configured"
              ? "Storybook preview is configured."
              : status === "needsCommandOverride"
                ? "Storybook exists, but Forma needs a preview start command."
                : status === "enableable"
                  ? "This project can enable Storybook-backed previews."
                  : "Forma could not detect a Storybook-compatible preview setup.",
        } satisfies PreviewProjectInspectionResult;
      },
      catch: (cause) => toPreviewError("Failed to inspect project preview configuration.", cause),
    });

  const workspaceLabel = (workspaceRootRelativePath: string) =>
    normalizeProjectPath(workspaceRootRelativePath) || "project root";

  const buildWorkspaceThreadTitle = (workspaceRootRelativePath: string) =>
    `Preview setup · ${workspaceLabel(workspaceRootRelativePath)}`;

  const persistWorkspaceRecord = (
    project: ProjectRecord,
    patch: {
      readonly workspaceRootRelativePath: string;
      readonly threadId?: ProjectPreviewWorkspaceRecord["threadId"] | undefined;
      readonly status: ProjectPreviewWorkspaceRecord["status"] | undefined;
      readonly lastTargetRelativePath?: string | null | undefined;
      readonly lastError?: string | null | undefined;
    },
  ) => {
    const currentRecord = getWorkspaceRecord(project, patch.workspaceRootRelativePath);
    const nextRecord: ProjectPreviewWorkspaceRecord = {
      workspaceRootRelativePath: normalizeProjectPath(patch.workspaceRootRelativePath),
      threadId: patch.threadId !== undefined ? patch.threadId : (currentRecord?.threadId ?? null),
      status: patch.status ?? currentRecord?.status ?? "unconfigured",
      lastTargetRelativePath:
        patch.lastTargetRelativePath !== undefined
          ? patch.lastTargetRelativePath
            ? asProjectRelativePath(patch.lastTargetRelativePath)
            : null
          : (currentRecord?.lastTargetRelativePath ?? null),
      lastError:
        patch.lastError !== undefined ? patch.lastError : (currentRecord?.lastError ?? null),
      updatedAt: new Date().toISOString(),
    };
    return updateProjectPreviewMetadata(project, {
      previewWorkspaceRecords: upsertWorkspaceRecord(project.previewWorkspaceRecords, nextRecord),
    });
  };

  const buildWorkspaceSetupReason = (
    ownerWorkspaceRootRelativePath: string,
    relativePath: string,
    inspection: StorybookInspectionDetails,
  ): string => {
    const ownerLabel = workspaceLabel(ownerWorkspaceRootRelativePath);
    const firstRelatedWorkspace =
      inspection.workspaces.find(
        (workspace) => workspace.workspaceRootRelativePath !== ownerWorkspaceRootRelativePath,
      ) ?? null;
    if (firstRelatedWorkspace) {
      return firstRelatedWorkspace.coverageStatus === "unproven"
        ? `Found Storybook in ${workspaceLabel(firstRelatedWorkspace.workspaceRootRelativePath)}, but Forma cannot prove its stories config covers ${ownerLabel}.`
        : `Found Storybook in ${workspaceLabel(firstRelatedWorkspace.workspaceRootRelativePath)}, but it does not cover ${ownerLabel}.`;
    }
    return `No preview workspace covers '${relativePath}'. Set up Storybook previews for ${ownerLabel}.`;
  };

  const buildWorkspaceSetupInspectionSummary = (
    ownerWorkspaceRootRelativePath: string,
    relativePath: string,
    inspection: StorybookInspectionDetails,
  ) => buildWorkspaceSetupReason(ownerWorkspaceRootRelativePath, relativePath, inspection);

  const buildWorkspaceSetupReviewSummary = (
    ownerWorkspaceRootRelativePath: string,
    relativePath: string,
    inspection: StorybookInspectionDetails,
  ): readonly string[] => {
    const ownerLabel = workspaceLabel(ownerWorkspaceRootRelativePath);
    const workspaceLines = inspection.workspaces.map((workspace) => {
      const coverageDescription =
        workspace.coverageStatus === "proven"
          ? `covers ${workspace.resolvedStoryGlobs.length} static stories globs`
          : "has dynamic or opaque stories config";
      return `${workspaceLabel(workspace.workspaceRootRelativePath)}: ${coverageDescription}`;
    });
    return [
      `Selected target: ${relativePath}`,
      `Owner workspace: ${ownerLabel}`,
      ...(workspaceLines.length > 0
        ? ["Existing Storybook workspaces:", ...workspaceLines]
        : ["No existing Storybook workspaces were detected in this repo."]),
    ];
  };

  const buildWorkspaceSetupInitialPrompt = (input: {
    readonly project: ProjectRecord;
    readonly ownerWorkspaceRootRelativePath: string;
    readonly relativePath: string;
    readonly targetKind: PreviewTargetKind;
    readonly inspection: StorybookInspectionDetails;
  }) => {
    const ownerLabel = workspaceLabel(input.ownerWorkspaceRootRelativePath);
    const storybookWorkspaceLines =
      input.inspection.workspaces.length > 0
        ? input.inspection.workspaces.map((workspace) => {
            const coverage =
              workspace.coverageStatus === "proven"
                ? workspace.resolvedStoryGlobs.length > 0
                  ? `static coverage globs: ${workspace.resolvedStoryGlobs.join(", ")}`
                  : "no static stories entries were found"
                : "stories config is dynamic or opaque";
            return `- ${workspaceLabel(workspace.workspaceRootRelativePath)}: ${coverage}`;
          })
        : ["- none detected"];

    return `Set up Storybook-backed component previews for the workspace \`${ownerLabel}\` in project \`${input.project.title}\`.

Target:
- selected ${input.targetKind}: \`${input.relativePath}\`
- owner workspace: \`${ownerLabel}\`

Existing Storybook workspaces in this repo:
${storybookWorkspaceLines.join("\n")}

Constraints:
- Prefer local workspace setup for \`${ownerLabel}\`.
- Reuse an existing Storybook only if it already covers the target.
- Do not silently extend unrelated Storybooks.
- Verify success by booting the Storybook runtime for \`${ownerLabel}\`.
- Use one reviewed setup session before making repo changes.

When setup is complete, summarize the exact files changed and the command that starts the workspace preview runtime.`;
  };

  const buildStoryWorkTurnPrompt = (input: {
    readonly workspaceRootRelativePath: string;
    readonly componentRelativePath: string;
    readonly storyRelativePath: string | null;
    readonly action: PreviewStoryWorkAction;
  }) => `Continue the preview setup for workspace \`${workspaceLabel(input.workspaceRootRelativePath)}\`.

Component:
- component path: \`${input.componentRelativePath}\`
- story path: ${input.storyRelativePath ? `\`${input.storyRelativePath}\`` : "not created yet"}
- requested action: ${input.action === "create" ? "create a Storybook story" : "fix the existing Storybook story"}

Expectation:
- the story should resolve in Storybook
- the component should render in the preview drawer`;

  const inspectProject: PreviewManagerShape["inspectProject"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      return yield* buildInspection(project);
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

  const startRuntime = (project: ProjectRecord, detectedCommand: string) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(stateRef)).runtimes.get(project.id);
      if (existing) {
        if (existing.command === detectedCommand) {
          const healthy = yield* Effect.promise(() => isStorybookReady(existing.baseUrl));
          if (healthy) {
            return {
              projectId: project.id,
              provider: "storybook",
              started: false,
              iframeBasePath: existing.iframeBasePath,
            } satisfies PreviewEnsureRuntimeResult;
          }
        }
        existing.child.kill("SIGTERM");
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
      const command = withConfiguredHost(
        withConfiguredPort(detectedCommand, port),
        PREVIEW_RUNTIME_HOST,
      );
      const child = spawn(command, {
        cwd: project.workspaceRoot,
        shell: true,
        stdio: "ignore",
        env: { ...process.env, PORT: String(port), STORYBOOK_DISABLE_TELEMETRY: "1" },
      });
      const runtimeRecord: RuntimeRecord = {
        projectId: project.id,
        cwd: project.workspaceRoot,
        command: detectedCommand,
        port,
        baseUrl: `http://${PREVIEW_RUNTIME_HOST}:${port}`,
        iframeBasePath: `/__preview/${project.id}`,
        child,
      };

      child.once("exit", () => {
        runFork(
          Ref.update(stateRef, (state) => {
            const activeRuntime = state.runtimes.get(project.id);
            if (!activeRuntime || activeRuntime.child !== child) {
              return state;
            }
            const nextRuntimes = new Map(state.runtimes);
            nextRuntimes.delete(project.id);
            return { ...state, runtimes: nextRuntimes };
          }).pipe(
            Effect.andThen(
              publishProjectEvent(project.id, { kind: "runtime.stopped", projectId: project.id }),
            ),
          ),
        );
      });

      yield* Effect.tryPromise({
        try: async () => {
          await waitForStorybookReady(runtimeRecord.baseUrl);
        },
        catch: (cause) => toPreviewError("Failed to start Storybook preview runtime.", cause),
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
        provider: "storybook",
        started: true,
        iframeBasePath: runtimeRecord.iframeBasePath,
      } satisfies PreviewEnsureRuntimeResult;
    });

  const ensureRuntime: PreviewManagerShape["ensureRuntime"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const inspection = yield* Effect.tryPromise({
        try: () => inspectStorybookProject(project.workspaceRoot),
        catch: (cause) =>
          toPreviewError("Failed to inspect Storybook preview configuration.", cause),
      });
      const effectiveCommand = resolveEffectivePreviewCommand(project, inspection);
      if (!effectiveCommand) {
        return yield* failPreview(
          !inspection.hasStorybookSetup &&
            inspection.framework !== "react" &&
            inspection.framework !== "nextjs"
            ? "Storybook preview is unavailable for this project."
            : !inspection.hasStorybookSetup
              ? "Storybook previews are not enabled for this project."
              : "A preview start command is required before Forma can open Storybook.",
        );
      }
      return yield* startRuntime(project, effectiveCommand);
    });

  const stopRuntime: PreviewManagerShape["stopRuntime"] = (input) =>
    Effect.gen(function* () {
      const runtime = (yield* Ref.get(stateRef)).runtimes.get(input.projectId);
      if (!runtime) return;
      runtime.child.kill("SIGTERM");
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

  const resolveStoryVariants = (
    _project: ProjectRecord,
    runtimeBaseUrl: string,
    runtimeIframeBasePath: string,
    workspaceRootRelativePath: string,
    storyRelativePath: string,
    targetKind: PreviewTargetKind,
    relativePath: string,
    componentRelativePath: string | null,
  ) =>
    Effect.gen(function* () {
      const storyEntries = yield* Effect.tryPromise({
        try: () => loadStorybookEntries(runtimeBaseUrl),
        catch: (cause) => toPreviewError("Failed to load Storybook stories for preview.", cause),
      });
      const normalizedStoryRelativePath = normalizeProjectPath(storyRelativePath);
      const normalizedWorkspaceRoot = normalizeProjectPath(workspaceRootRelativePath);
      const workspaceRelativeStoryPath =
        normalizedWorkspaceRoot.length > 0 &&
        normalizedStoryRelativePath.startsWith(`${normalizedWorkspaceRoot}/`)
          ? normalizedStoryRelativePath.slice(normalizedWorkspaceRoot.length + 1)
          : normalizedStoryRelativePath;
      const variants = storyEntries
        .filter(
          (entry) =>
            entry.type === "story" &&
            typeof entry.importPath === "string" &&
            (() => {
              const importPath = normalizeStorybookImportPath(entry.importPath);
              return (
                importPath === normalizedStoryRelativePath ||
                importPath.endsWith(normalizedStoryRelativePath) ||
                importPath === workspaceRelativeStoryPath ||
                importPath.endsWith(workspaceRelativeStoryPath)
              );
            })(),
        )
        .map((entry) => ({
          storyId: entry.id,
          exportName: entry.name ?? entry.id,
          name: entry.name ?? entry.id,
        }));
      if (variants.length === 0) {
        return yield* failPreview(
          `No Storybook variants were found for '${normalizedStoryRelativePath}'.`,
        );
      }
      return {
        status: "resolved",
        targetKind,
        relativePath: asProjectRelativePath(relativePath),
        componentRelativePath: componentRelativePath
          ? asProjectRelativePath(componentRelativePath)
          : null,
        storyRelativePath: asProjectRelativePath(storyRelativePath),
        initialStoryId: variants[0]!.storyId,
        iframePath: `${runtimeIframeBasePath}/iframe.html?id=${encodeURIComponent(variants[0]!.storyId)}&viewMode=story`,
        directIframeUrl: `${runtimeBaseUrl}/iframe.html?id=${encodeURIComponent(variants[0]!.storyId)}&viewMode=story`,
        variants,
      } satisfies PreviewResolveTargetResult;
    });

  const resolveTarget: PreviewManagerShape["resolveTarget"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const inspection = yield* Effect.tryPromise({
        try: () => inspectStorybookProject(project.workspaceRoot),
        catch: (cause) =>
          toPreviewError("Failed to inspect Storybook preview configuration.", cause),
      });
      const relativePath = normalizeProjectPath(input.relativePath);
      const absolutePath = path.join(project.workspaceRoot, relativePath);
      const exists = yield* Effect.tryPromise({
        try: () => pathExists(absolutePath),
        catch: (cause) => toPreviewError("Failed to resolve the selected preview target.", cause),
      });
      if (!exists) {
        return {
          status: "notFound",
          targetKind: input.targetKind,
          relativePath: asProjectRelativePath(relativePath),
        } satisfies PreviewResolveTargetResult;
      }

      const ownerWorkspace = yield* Effect.tryPromise({
        try: () => resolveOwnerWorkspaceForPath(project.workspaceRoot, relativePath),
        catch: (cause) =>
          toPreviewError("Failed to resolve the owning workspace for this preview target.", cause),
      });
      const ownerWorkspaceRootRelativePath = normalizeProjectPath(
        ownerWorkspace?.workspaceRootRelativePath ?? "",
      );
      const workspaceRecord = getWorkspaceRecord(project, ownerWorkspaceRootRelativePath);
      const buildNeedsWorkspaceSetupResult = (reason: string): PreviewResolveTargetResult => ({
        status: "needsWorkspaceSetup",
        targetKind: input.targetKind,
        relativePath: asProjectRelativePath(relativePath),
        ownerWorkspaceRootRelativePath,
        coveringWorkspaceRootRelativePath: null,
        existingThreadId: workspaceRecord?.threadId ?? null,
        reason,
      });

      if (input.targetKind === "story") {
        if (!isStoryPath(relativePath)) {
          return {
            status: "unsupportedTarget",
            targetKind: input.targetKind,
            relativePath: asProjectRelativePath(relativePath),
            reason: "Only Storybook story files can be opened as direct preview targets.",
          } satisfies PreviewResolveTargetResult;
        }
        const storyWorkspace = pickCoveringStorybookWorkspaceForPath(
          inspection.workspaces,
          relativePath,
        );
        if (!storyWorkspace) {
          return buildNeedsWorkspaceSetupResult(
            buildWorkspaceSetupReason(ownerWorkspaceRootRelativePath, relativePath, inspection),
          );
        }
        const effectiveCommand = resolveEffectivePreviewCommand(
          project,
          inspection,
          storyWorkspace.workspaceRootRelativePath,
        );
        if (!effectiveCommand) {
          return {
            status: "needsCommandOverride",
            targetKind: input.targetKind,
            relativePath: asProjectRelativePath(relativePath),
            workspaceRootRelativePath: storyWorkspace.workspaceRootRelativePath,
            detectedCommands: storyWorkspace.commandCandidates.length
              ? storyWorkspace.commandCandidates
              : inspection.detectedStartCommands,
          } satisfies PreviewResolveTargetResult;
        }
        const runtimeExit = yield* Effect.exit(startRuntime(project, effectiveCommand));
        if (!Exit.isSuccess(runtimeExit)) {
          if (!workspaceRecord?.threadId) {
            return yield* Effect.failCause(runtimeExit.cause);
          }
          const runtimeFailure = Cause.squash(runtimeExit.cause);
          const runtimeMessage =
            runtimeFailure instanceof Error ? runtimeFailure.message : String(runtimeFailure);
          yield* persistWorkspaceRecord(project, {
            workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
            status: "setup_failed",
            lastTargetRelativePath: relativePath,
            lastError: runtimeMessage,
          });
          return buildNeedsWorkspaceSetupResult(runtimeMessage);
        }
        const runtime = runtimeExit.value;
        const runtimeTarget = (yield* Ref.get(stateRef)).runtimes.get(project.id);
        if (!runtimeTarget) {
          return yield* failPreview("Preview runtime was not available after startup.");
        }
        const resolvedTarget = yield* resolveStoryVariants(
          project,
          runtimeTarget.baseUrl,
          runtime.iframeBasePath,
          storyWorkspace.workspaceRootRelativePath,
          relativePath,
          input.targetKind,
          relativePath,
          null,
        );
        if (workspaceRecord) {
          yield* persistWorkspaceRecord(project, {
            workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
            status: "ready",
            lastTargetRelativePath: relativePath,
            lastError: null,
          });
        }
        return resolvedTarget;
      }

      if (!isComponentPath(relativePath)) {
        return {
          status: "unsupportedTarget",
          targetKind: input.targetKind,
          relativePath: asProjectRelativePath(relativePath),
          reason: "Only component source files can be previewed from this action.",
        } satisfies PreviewResolveTargetResult;
      }

      const mappedStory = project.previewConfig?.componentStoryMappings?.[relativePath] ?? null;
      const storyCandidates = mappedStory
        ? [mappedStory]
        : yield* Effect.tryPromise({
            try: () => inferStoryCandidates(project.workspaceRoot, relativePath),
            catch: (cause) =>
              toPreviewError("Failed to resolve story candidates for component preview.", cause),
          });
      const generatedStoryRelativePath = storyFilePathForComponent(relativePath);

      if (storyCandidates.length === 0) {
        const generatedStoryWorkspace = pickCoveringStorybookWorkspaceForPath(
          inspection.workspaces,
          generatedStoryRelativePath,
        );
        if (generatedStoryWorkspace) {
          return {
            status: "needsStoryWork",
            componentRelativePath: asProjectRelativePath(relativePath),
            storyRelativePath: null,
            action: "create",
            workspaceRootRelativePath: generatedStoryWorkspace.workspaceRootRelativePath,
            threadId: workspaceRecord?.threadId ?? null,
          } satisfies PreviewResolveTargetResult;
        }
        return buildNeedsWorkspaceSetupResult(
          buildWorkspaceSetupReason(ownerWorkspaceRootRelativePath, relativePath, inspection),
        );
      }

      const coveredStoryCandidates = storyCandidates.filter((candidatePath) =>
        Boolean(pickCoveringStorybookWorkspaceForPath(inspection.workspaces, candidatePath)),
      );

      if (coveredStoryCandidates.length > 1) {
        return {
          status: "needsStoryChoice",
          componentRelativePath: asProjectRelativePath(relativePath),
          storyChoices: coveredStoryCandidates.map((candidatePath) => ({
            relativePath: asProjectRelativePath(candidatePath),
            displayName: displayNameForPath(candidatePath),
          })),
        } satisfies PreviewResolveTargetResult;
      }

      if (coveredStoryCandidates.length === 0) {
        return buildNeedsWorkspaceSetupResult(
          buildWorkspaceSetupReason(ownerWorkspaceRootRelativePath, relativePath, inspection),
        );
      }

      const storyRelativePath = coveredStoryCandidates[0]!;
      const storyWorkspace = pickCoveringStorybookWorkspaceForPath(
        inspection.workspaces,
        storyRelativePath,
      );
      if (!storyWorkspace) {
        return buildNeedsWorkspaceSetupResult(
          buildWorkspaceSetupReason(ownerWorkspaceRootRelativePath, relativePath, inspection),
        );
      }
      const effectiveCommand = resolveEffectivePreviewCommand(
        project,
        inspection,
        storyWorkspace.workspaceRootRelativePath,
      );
      if (!effectiveCommand) {
        return {
          status: "needsCommandOverride",
          targetKind: input.targetKind,
          relativePath: asProjectRelativePath(relativePath),
          workspaceRootRelativePath: storyWorkspace.workspaceRootRelativePath,
          detectedCommands: storyWorkspace.commandCandidates.length
            ? storyWorkspace.commandCandidates
            : inspection.detectedStartCommands,
        } satisfies PreviewResolveTargetResult;
      }
      const runtimeExit = yield* Effect.exit(startRuntime(project, effectiveCommand));
      if (!Exit.isSuccess(runtimeExit)) {
        if (!workspaceRecord?.threadId) {
          return yield* Effect.failCause(runtimeExit.cause);
        }
        const runtimeFailure = Cause.squash(runtimeExit.cause);
        const runtimeMessage =
          runtimeFailure instanceof Error ? runtimeFailure.message : String(runtimeFailure);
        yield* persistWorkspaceRecord(project, {
          workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
          status: "setup_failed",
          lastTargetRelativePath: relativePath,
          lastError: runtimeMessage,
        });
        return buildNeedsWorkspaceSetupResult(runtimeMessage);
      }
      const runtime = runtimeExit.value;
      const runtimeTarget = (yield* Ref.get(stateRef)).runtimes.get(project.id);
      if (!runtimeTarget) {
        return yield* failPreview("Preview runtime was not available after startup.");
      }
      const variantResolutionExit = yield* Effect.exit(
        resolveStoryVariants(
          project,
          runtimeTarget.baseUrl,
          runtime.iframeBasePath,
          storyWorkspace.workspaceRootRelativePath,
          storyRelativePath,
          input.targetKind,
          relativePath,
          relativePath,
        ),
      );
      if (!Exit.isSuccess(variantResolutionExit)) {
        if (workspaceRecord) {
          yield* persistWorkspaceRecord(project, {
            workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
            status: "story_work_pending",
            lastTargetRelativePath: relativePath,
            lastError: null,
          });
        }
        return {
          status: "needsStoryWork",
          componentRelativePath: asProjectRelativePath(relativePath),
          storyRelativePath: asProjectRelativePath(storyRelativePath),
          action: "fix",
          workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
          threadId: workspaceRecord?.threadId ?? null,
        } satisfies PreviewResolveTargetResult;
      }
      const variantResolution = variantResolutionExit.value;
      if (workspaceRecord) {
        yield* persistWorkspaceRecord(project, {
          workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
          status: "ready",
          lastTargetRelativePath: relativePath,
          lastError: null,
        });
      }
      return variantResolution;
    });

  const chooseStoryMapping: PreviewManagerShape["chooseStoryMapping"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const nextConfig = buildPreviewConfig(project.previewConfig, {
        componentStoryMappings: {
          [input.componentRelativePath]: input.storyRelativePath,
        },
      });
      yield* updateProjectPreviewMetadata(project, { previewConfig: nextConfig }).pipe(
        Effect.mapError((cause) => toPreviewError("Failed to save preview story mapping.", cause)),
      );
    });

  const setStartCommandOverride: PreviewManagerShape["setStartCommandOverride"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const nextConfig = buildPreviewConfig(project.previewConfig, {
        workspaceCommandOverrides: {
          [normalizeProjectPath(input.workspaceRootRelativePath)]: input.command,
        },
      });
      yield* updateProjectPreviewMetadata(project, { previewConfig: nextConfig }).pipe(
        Effect.mapError((cause) =>
          toPreviewError("Failed to save preview start command override.", cause),
        ),
      );
    });

  const prepareWorkspaceSetupThread: PreviewManagerShape["prepareWorkspaceSetupThread"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const inspection = yield* Effect.tryPromise({
        try: () => inspectStorybookProject(project.workspaceRoot),
        catch: (cause) =>
          toPreviewError("Failed to inspect Storybook preview configuration.", cause),
      });
      const ownerWorkspace = yield* Effect.tryPromise({
        try: () => resolveOwnerWorkspaceForPath(project.workspaceRoot, input.relativePath),
        catch: (cause) =>
          toPreviewError("Failed to resolve the owning workspace for this preview target.", cause),
      });
      const ownerWorkspaceRootRelativePath = normalizeProjectPath(
        ownerWorkspace?.workspaceRootRelativePath ?? "",
      );
      const workspaceRecord = getWorkspaceRecord(project, ownerWorkspaceRootRelativePath);
      return {
        workspaceRootRelativePath: ownerWorkspaceRootRelativePath,
        existingThreadId: workspaceRecord?.threadId ?? null,
        threadTitle: buildWorkspaceThreadTitle(ownerWorkspaceRootRelativePath),
        initialPrompt: buildWorkspaceSetupInitialPrompt({
          project,
          ownerWorkspaceRootRelativePath,
          relativePath: normalizeProjectPath(input.relativePath),
          targetKind: input.targetKind,
          inspection,
        }),
        inspectionSummary: buildWorkspaceSetupInspectionSummary(
          ownerWorkspaceRootRelativePath,
          normalizeProjectPath(input.relativePath),
          inspection,
        ),
        reviewSummary: [
          ...buildWorkspaceSetupReviewSummary(
            ownerWorkspaceRootRelativePath,
            normalizeProjectPath(input.relativePath),
            inspection,
          ),
        ],
      } satisfies PreviewPrepareWorkspaceSetupThreadResult;
    });

  const prepareStoryWorkTurn: PreviewManagerShape["prepareStoryWorkTurn"] = (input) =>
    Effect.gen(function* () {
      const project = yield* getProjectById(input.projectId);
      const inspection = yield* Effect.tryPromise({
        try: () => inspectStorybookProject(project.workspaceRoot),
        catch: (cause) =>
          toPreviewError("Failed to inspect Storybook preview configuration.", cause),
      });
      const ownerWorkspace = yield* Effect.tryPromise({
        try: () => resolveOwnerWorkspaceForPath(project.workspaceRoot, input.componentRelativePath),
        catch: (cause) =>
          toPreviewError(
            "Failed to resolve the owning workspace for this preview story action.",
            cause,
          ),
      });
      const workspaceRootRelativePath = normalizeProjectPath(
        ownerWorkspace?.workspaceRootRelativePath ?? "",
      );
      const workspaceRecord = getWorkspaceRecord(project, workspaceRootRelativePath);
      const mappedStory =
        project.previewConfig?.componentStoryMappings?.[
          normalizeProjectPath(input.componentRelativePath)
        ] ?? null;
      const storyCandidates = mappedStory
        ? [mappedStory]
        : yield* Effect.tryPromise({
            try: () => inferStoryCandidates(project.workspaceRoot, input.componentRelativePath),
            catch: (cause) =>
              toPreviewError("Failed to resolve story candidates for preview story work.", cause),
          });
      const firstCoveredStoryCandidate =
        storyCandidates.find((candidatePath) =>
          Boolean(pickCoveringStorybookWorkspaceForPath(inspection.workspaces, candidatePath)),
        ) ?? null;
      return {
        workspaceRootRelativePath,
        threadId: workspaceRecord?.threadId ?? null,
        turnPrompt: buildStoryWorkTurnPrompt({
          workspaceRootRelativePath,
          componentRelativePath: normalizeProjectPath(input.componentRelativePath),
          storyRelativePath: firstCoveredStoryCandidate,
          action: input.action,
        }),
        storyRelativePath: firstCoveredStoryCandidate
          ? asProjectRelativePath(firstCoveredStoryCandidate)
          : null,
      } satisfies PreviewPrepareStoryWorkTurnResult;
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
        Effect.forEach(
          state.runtimes.values(),
          (runtime) => Effect.sync(() => runtime.child.kill("SIGTERM")),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
      ),
    ),
  );

  return {
    inspectProject,
    searchComponents,
    resolveTarget,
    chooseStoryMapping,
    setStartCommandOverride,
    prepareWorkspaceSetupThread,
    prepareStoryWorkTurn,
    ensureRuntime,
    issueAccessToken,
    stopRuntime,
    streamProject,
    getRuntimeTarget,
    authenticateAccessToken,
  } satisfies PreviewManagerShape;
});

export const PreviewManagerLive = Layer.effect(PreviewManager, makePreviewManager);
