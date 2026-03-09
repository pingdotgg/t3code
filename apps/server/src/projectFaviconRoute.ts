import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { listProjectFilePaths } from "./projectFiles";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

const RECURSIVE_FAVICON_FILENAMES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "icon.svg",
  "icon.png",
  "icon.ico",
  "logo.svg",
  "logo.png",
] as const;

const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

const RECURSIVE_FAVICON_FILENAME_SET = new Set<string>(RECURSIVE_FAVICON_FILENAMES);
const RECURSIVE_FAVICON_PRIORITY = new Map<string, number>(
  RECURSIVE_FAVICON_FILENAMES.map((filename, index) => [filename, index]),
);

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

function resolveIconHref(projectCwd: string, href: string): string[] {
  const clean = href.replace(/^\//, "");
  return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
}

function isPathWithinProject(projectCwd: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function serveFaviconFile(filePath: string, res: http.ServerResponse): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(data);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Read error");
    }
  }
}

function serveFallbackFavicon(res: http.ServerResponse): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(FALLBACK_FAVICON_SVG);
}

function basenameOfPosixPath(relativePath: string): string {
  const segments = relativePath.split("/");
  return segments[segments.length - 1] ?? relativePath;
}

function relativePathWithinApp(relativePath: string): string | null {
  const segments = relativePath.split("/");
  if (segments.length < 3 || segments[0] !== "apps") {
    return null;
  }
  return segments.slice(2).join("/");
}

function recursiveFaviconLocationRank(relativePath: string): number {
  const appRelativePath = relativePathWithinApp(relativePath);
  if (!appRelativePath) {
    return 4;
  }
  if (appRelativePath.startsWith("public/")) {
    return 0;
  }
  if (appRelativePath.startsWith("app/")) {
    return 1;
  }
  if (appRelativePath.startsWith("src/app/")) {
    return 2;
  }
  if (!appRelativePath.includes("/")) {
    return 3;
  }
  return 4;
}

function recursiveFaviconDepth(relativePath: string): number {
  const scopedPath = relativePathWithinApp(relativePath) ?? relativePath;
  return Math.max(0, scopedPath.split("/").length - 1);
}

function recursiveFaviconFilenamePriority(relativePath: string): number {
  return (
    RECURSIVE_FAVICON_PRIORITY.get(basenameOfPosixPath(relativePath)) ?? Number.MAX_SAFE_INTEGER
  );
}

function compareRecursiveFaviconPaths(left: string, right: string): number {
  const leftInApps = relativePathWithinApp(left) ? 0 : 1;
  const rightInApps = relativePathWithinApp(right) ? 0 : 1;
  if (leftInApps !== rightInApps) {
    return leftInApps - rightInApps;
  }

  const locationDelta = recursiveFaviconLocationRank(left) - recursiveFaviconLocationRank(right);
  if (locationDelta !== 0) {
    return locationDelta;
  }

  const depthDelta = recursiveFaviconDepth(left) - recursiveFaviconDepth(right);
  if (depthDelta !== 0) {
    return depthDelta;
  }

  const filenameDelta =
    recursiveFaviconFilenamePriority(left) - recursiveFaviconFilenamePriority(right);
  if (filenameDelta !== 0) {
    return filenameDelta;
  }

  return left.localeCompare(right);
}

async function tryServeResolvedPaths(
  projectCwd: string,
  candidatePaths: readonly string[],
  res: http.ServerResponse,
): Promise<boolean> {
  for (const candidatePath of candidatePaths) {
    if (!isPathWithinProject(projectCwd, candidatePath) || !(await isFile(candidatePath))) {
      continue;
    }
    await serveFaviconFile(candidatePath, res);
    return true;
  }
  return false;
}

async function findRecursiveFaviconPath(projectCwd: string): Promise<string | null> {
  const relativeFilePaths = await listProjectFilePaths(projectCwd);
  const bestCandidate = relativeFilePaths
    .filter((relativePath) => RECURSIVE_FAVICON_FILENAME_SET.has(basenameOfPosixPath(relativePath)))
    .toSorted(compareRecursiveFaviconPaths)[0];
  if (!bestCandidate) {
    return null;
  }

  const absolutePath = path.join(projectCwd, bestCandidate);
  if (!isPathWithinProject(projectCwd, absolutePath)) {
    return null;
  }
  return absolutePath;
}

async function handleProjectFaviconRequest(url: URL, res: http.ServerResponse): Promise<void> {
  const projectCwd = url.searchParams.get("cwd");
  if (!projectCwd) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing cwd parameter");
    return;
  }

  for (const relativeCandidate of FAVICON_CANDIDATES) {
    const candidatePath = path.join(projectCwd, relativeCandidate);
    if (await tryServeResolvedPaths(projectCwd, [candidatePath], res)) {
      return;
    }
  }

  for (const sourceRelativePath of ICON_SOURCE_FILES) {
    const sourceFilePath = path.join(projectCwd, sourceRelativePath);
    let content: string;
    try {
      content = await fs.readFile(sourceFilePath, "utf8");
    } catch {
      continue;
    }

    const href = extractIconHref(content);
    if (!href) {
      continue;
    }

    if (await tryServeResolvedPaths(projectCwd, resolveIconHref(projectCwd, href), res)) {
      return;
    }
  }

  try {
    const recursiveFaviconPath = await findRecursiveFaviconPath(projectCwd);
    if (
      recursiveFaviconPath &&
      (await tryServeResolvedPaths(projectCwd, [recursiveFaviconPath], res))
    ) {
      return;
    }
  } catch {
    // Fall back to the generated icon if recursive discovery fails.
  }

  serveFallbackFavicon(res);
}

export function tryHandleProjectFaviconRequest(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== "/api/project-favicon") {
    return false;
  }

  void handleProjectFaviconRequest(url, res).catch(() => {
    serveFallbackFavicon(res);
  });
  return true;
}
