import http from "node:http";
import path from "node:path";
import { Effect, FileSystem } from "effect";

import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

export const tryHandleProjectFaviconRequest = Effect.fn("tryHandleProjectFaviconRequest")(
  function* (
    url: URL,
    res: http.ServerResponse,
  ): Effect.fn.Return<boolean, never, ProjectFaviconResolver | FileSystem.FileSystem> {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    if (url.pathname !== "/api/project-favicon") {
      return false;
    }

    const projectCwd = url.searchParams.get("cwd");
    if (!projectCwd) {
      respond(400, { "Content-Type": "text/plain" }, "Missing cwd parameter");
      return true;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const faviconResolver = yield* ProjectFaviconResolver;
    const resolvedPath = yield* faviconResolver.resolvePath(projectCwd);

    if (!resolvedPath) {
      respond(
        200,
        {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        },
        FALLBACK_FAVICON_SVG,
      );
      return true;
    }

    const data = yield* fileSystem
      .readFile(resolvedPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      respond(500, { "Content-Type": "text/plain" }, "Read error");
      return true;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";
    respond(
      200,
      {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
      data,
    );
    return true;
  },
);
