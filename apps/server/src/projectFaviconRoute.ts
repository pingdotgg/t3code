import { Effect, FileSystem, Path } from "effect";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

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

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

export type ProjectFaviconRouteResult =
  | {
      readonly kind: "file";
      readonly filePath: string;
      readonly contentType: string;
      readonly cacheControl: string;
    }
  | {
      readonly kind: "body";
      readonly statusCode: number;
      readonly body: string;
      readonly contentType: string;
      readonly cacheControl?: string;
    };

const cacheControl = "public, max-age=3600";

const resolveIconHref = Effect.fnUntraced(function* (
  projectCwd: string,
  href: string,
): Effect.fn.Return<readonly [string, string], never, Path.Path> {
  const path = yield* Path.Path;
  const clean = href.replace(/^\//, "");
  return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
});

const isPathWithinProject = Effect.fnUntraced(function* (
  projectCwd: string,
  candidatePath: string,
): Effect.fn.Return<boolean, never, Path.Path> {
  const path = yield* Path.Path;
  const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
});

const toFileResult = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<ProjectFaviconRouteResult, never, Path.Path> {
  const path = yield* Path.Path;
  const ext = path.extname(filePath).toLowerCase();
  return {
    kind: "file",
    filePath,
    contentType: FAVICON_MIME_TYPES[ext] ?? "application/octet-stream",
    cacheControl,
  };
});

const findExistingFile = Effect.fnUntraced(function* (
  candidates: ReadonlyArray<string>,
  projectCwd: string,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of candidates) {
    if (!(yield* isPathWithinProject(projectCwd, candidate))) {
      continue;
    }
    const fileInfo = yield* fileSystem
      .stat(candidate)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (fileInfo?.type === "File") {
      return candidate;
    }
  }
  return null;
});

export const resolveProjectFaviconRoute = Effect.fnUntraced(function* (
  url: URL,
): Effect.fn.Return<ProjectFaviconRouteResult | null, never, Path.Path | FileSystem.FileSystem> {
  const path = yield* Path.Path;

  if (url.pathname !== "/api/project-favicon") {
    return null;
  }

  const projectCwd = url.searchParams.get("cwd");
  if (!projectCwd) {
    return {
      kind: "body",
      statusCode: 400,
      body: "Missing cwd parameter",
      contentType: "text/plain",
    };
  }

  const candidatePaths = FAVICON_CANDIDATES.map((candidate) => path.join(projectCwd, candidate));
  const directFile = yield* findExistingFile(candidatePaths, projectCwd);
  if (directFile) {
    return yield* toFileResult(directFile);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  for (const sourceFile of ICON_SOURCE_FILES) {
    const content = yield* fileSystem
      .readFileString(path.join(projectCwd, sourceFile))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!content) {
      continue;
    }

    const href = extractIconHref(content);
    if (!href) {
      continue;
    }

    const iconHrefPaths = yield* resolveIconHref(projectCwd, href);
    const resolvedFile = yield* findExistingFile(iconHrefPaths, projectCwd);
    if (resolvedFile) {
      return yield* toFileResult(resolvedFile);
    }
  }

  return {
    kind: "body",
    statusCode: 200,
    body: FALLBACK_FAVICON_SVG,
    contentType: "image/svg+xml",
    cacheControl,
  };
});
