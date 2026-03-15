import fs from "node:fs";

import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { ServerConfig } from "./config";
import { resolveProjectFaviconRoute, type ProjectFaviconRouteResult } from "./projectFaviconRoute";
import { makeServerRpcRouteLayer, type ServerRpcRouteRequirements } from "./serverRpc";

const textResponse = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, contentType: "text/plain" });

const toHttpResponseFromProjectFavicon = (
  result: ProjectFaviconRouteResult,
): HttpServerResponse.HttpServerResponse => {
  if (result.kind === "file") {
    return HttpServerResponse.raw(fs.createReadStream(result.filePath), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": result.cacheControl,
      },
    });
  }

  return HttpServerResponse.text(result.body, {
    status: result.statusCode,
    contentType: result.contentType,
    headers: result.cacheControl ? { "Cache-Control": result.cacheControl } : undefined,
  });
};

export type ServerRouteRequirements = ServerRpcRouteRequirements;

export const makeRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const { staticDir, devUrl } = serverConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (!devUrl && !staticDir) {
      yield* Effect.logWarning(
        "web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable",
        {
          hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
        },
      );
    }

    const healthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.json({ ok: true }));

    const attachmentsRoute = HttpRouter.add(
      "GET",
      `${ATTACHMENTS_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (!url) {
          return textResponse(400, "Bad Request");
        }

        const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
        const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
        if (!normalizedRelativePath) {
          return textResponse(400, "Invalid attachment path");
        }

        const isIdLookup =
          !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
        const filePath = isIdLookup
          ? resolveAttachmentPathById({
              stateDir: serverConfig.stateDir,
              attachmentId: normalizedRelativePath,
            })
          : resolveAttachmentRelativePath({
              stateDir: serverConfig.stateDir,
              relativePath: normalizedRelativePath,
            });

        if (!filePath) {
          return textResponse(
            isIdLookup ? 404 : 400,
            isIdLookup ? "Not Found" : "Invalid attachment path",
          );
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          return textResponse(404, "Not Found");
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        return HttpServerResponse.stream(fileSystem.stream(filePath), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }),
    );

    const projectFaviconRoute = HttpRouter.add(
      "GET",
      "/api/project-favicon",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (!url) {
          return textResponse(400, "Bad Request");
        }

        const result = yield* resolveProjectFaviconRoute(url);

        if (!result) {
          return textResponse(404, "Not Found");
        }

        return toHttpResponseFromProjectFavicon(result);
      }),
    );

    const staticRoute = HttpRouter.add(
      "GET",
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (!url) {
          return textResponse(400, "Bad Request");
        }

        if (devUrl) {
          return HttpServerResponse.redirect(new URL(`${url.pathname}${url.search}`, devUrl), {
            status: 307,
            headers: { "cache-control": "no-store" },
          });
        }

        if (!staticDir) {
          return textResponse(503, "No static directory configured and no dev URL set.");
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");

        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          return textResponse(400, "Invalid static file path");
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          return textResponse(400, "Invalid static file path");
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            return textResponse(400, "Invalid static file path");
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            return textResponse(404, "Not Found");
          }
          return HttpServerResponse.uint8Array(indexData, {
            contentType: "text/html; charset=utf-8",
          });
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          return textResponse(500, "Internal Server Error");
        }

        return HttpServerResponse.uint8Array(data, {
          contentType,
        });
      }),
    );

    const baseRoutesLayer = Layer.mergeAll(
      healthRoute,
      attachmentsRoute,
      projectFaviconRoute,
      staticRoute,
    );

    return makeServerRpcRouteLayer.pipe(Layer.provideMerge(baseRoutesLayer));
  }),
);
