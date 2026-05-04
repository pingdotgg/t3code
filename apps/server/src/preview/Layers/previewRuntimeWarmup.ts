import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface PreviewRuntimeWarmupInput {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly runtimeDir: string;
  readonly harnessRuntimeModulePath: string;
  readonly componentRelativePath: string;
  readonly previewFileRelativePath: string;
  readonly previewComponentRelativePath: string | null;
  readonly moduleMocks: Readonly<Record<string, string>>;
}

export interface PreviewRuntimeWarmupPlan {
  readonly cacheDir: string;
  readonly warmupFiles: readonly string[];
  readonly readinessPaths: readonly string[];
}

function normalizeFsPath(filePath: string): string {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function normalizeProjectPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function normalizeViteFsPath(filePath: string): string {
  const resolved = normalizeFsPath(filePath);
  return resolved.startsWith("/") ? `/@fs${resolved}` : `/@fs/${resolved}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function buildPreviewRuntimeCacheDir(input: {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
}): string {
  const digest = createHash("sha256")
    .update(normalizeFsPath(input.projectRoot))
    .update("\0")
    .update(normalizeFsPath(input.workspaceRoot))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), "forma-preview-harness-cache", digest);
}

export function buildPreviewRuntimeWarmupPlan(
  input: PreviewRuntimeWarmupInput,
): PreviewRuntimeWarmupPlan {
  const projectPreviewRoot = path.join(input.projectRoot, ".forma", "preview");
  const previewFilePath = path.join(input.projectRoot, input.previewFileRelativePath);
  const componentFilePath = path.join(
    input.projectRoot,
    input.previewComponentRelativePath ?? input.componentRelativePath,
  );
  const mockFilePaths = Object.values(input.moduleMocks).map((relativePath) =>
    path.join(input.projectRoot, normalizeProjectPath(relativePath)),
  );

  const absoluteWarmupFiles = dedupeStrings([
    path.join(input.runtimeDir, "src", "main.tsx"),
    input.harnessRuntimeModulePath,
    path.join(projectPreviewRoot, "wrapper.tsx"),
    path.join(projectPreviewRoot, "mocks.ts"),
    previewFilePath,
    componentFilePath,
    ...mockFilePaths,
  ]).map(normalizeFsPath);

  const readinessPaths = dedupeStrings([
    "/preview.html",
    "/src/main.tsx",
    `${normalizeViteFsPath(previewFilePath)}?import`,
    `${normalizeViteFsPath(path.join(projectPreviewRoot, "wrapper.tsx"))}?import`,
    `${normalizeViteFsPath(path.join(projectPreviewRoot, "mocks.ts"))}?import`,
    `${normalizeViteFsPath(componentFilePath)}?import`,
    ...mockFilePaths.map((mockFilePath) => `${normalizeViteFsPath(mockFilePath)}?import`),
  ]);

  return {
    cacheDir: buildPreviewRuntimeCacheDir(input),
    warmupFiles: absoluteWarmupFiles,
    readinessPaths,
  };
}

export function parsePreviewComponentRelativePath(source: string): string | null {
  const componentMatch = source.match(/component\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/);
  const rawComponentPath = componentMatch?.[2]?.trim();
  return rawComponentPath && rawComponentPath.length > 0
    ? rawComponentPath.replaceAll("\\", "/")
    : null;
}
