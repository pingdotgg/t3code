import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Well-known favicon paths checked in order.
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
];

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

// Matches <link rel="icon" href="..."> or { rel: "icon", href: "..." } patterns.
const LINK_ICON_HTML_RE = /<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"'?]+)/i;
const LINK_ICON_OBJ_RE = /rel:\s*["'](?:icon|shortcut icon)["'][^}]*href:\s*["']([^"'?]+)/i;

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

function serveFaviconFile(filePath: string, res: http.ServerResponse): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";
  fs.readFile(filePath, (readErr, data) => {
    if (readErr) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Read error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(data);
  });
}

export function tryHandleProjectFaviconRequest(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== "/api/project-favicon") {
    return false;
  }

  const projectCwd = url.searchParams.get("cwd");
  if (!projectCwd) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing cwd parameter");
    return true;
  }

  const tryResolvedPaths = (paths: string[], index: number, onExhausted: () => void): void => {
    if (index >= paths.length) {
      onExhausted();
      return;
    }
    const candidate = paths[index]!;
    if (!isPathWithinProject(projectCwd, candidate)) {
      tryResolvedPaths(paths, index + 1, onExhausted);
      return;
    }
    fs.stat(candidate, (err, stats) => {
      if (err || !stats?.isFile()) {
        tryResolvedPaths(paths, index + 1, onExhausted);
        return;
      }
      serveFaviconFile(candidate, res);
    });
  };

  const trySourceFiles = (index: number): void => {
    if (index >= ICON_SOURCE_FILES.length) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("No favicon found");
      return;
    }
    const sourceFile = path.join(projectCwd, ICON_SOURCE_FILES[index]!);
    fs.readFile(sourceFile, "utf8", (err, content) => {
      if (err) {
        trySourceFiles(index + 1);
        return;
      }
      const href = extractIconHref(content);
      if (!href) {
        trySourceFiles(index + 1);
        return;
      }
      const candidates = resolveIconHref(projectCwd, href);
      tryResolvedPaths(candidates, 0, () => trySourceFiles(index + 1));
    });
  };

  const tryCandidates = (index: number): void => {
    if (index >= FAVICON_CANDIDATES.length) {
      trySourceFiles(0);
      return;
    }
    const candidate = path.join(projectCwd, FAVICON_CANDIDATES[index]!);
    if (!isPathWithinProject(projectCwd, candidate)) {
      tryCandidates(index + 1);
      return;
    }
    fs.stat(candidate, (err, stats) => {
      if (err || !stats?.isFile()) {
        tryCandidates(index + 1);
        return;
      }
      serveFaviconFile(candidate, res);
    });
  };

  tryCandidates(0);
  return true;
}
