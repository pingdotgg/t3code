// @effect-diagnostics nodeBuiltinImport:off - tests inject swaps at the native open boundary.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeFSP from "node:fs/promises";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetPreviewTypeValidationError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClientRequest, HttpClientResponse, HttpServerResponse } from "effect/http";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse } from "../http.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, readMcpAppHtml, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { fakeSourceControlDriverInstance } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { sourceControlMediaResponse } from "./sourceControlMediaResponse.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};

const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === screenshotItem.id
          ? screenshotItem
          : itemId === oversizedScreenshotItem.id
            ? oversizedScreenshotItem
            : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));



describe("AssetAccess", () => {
  it.effect("previews workspace files with literal fragment characters in their paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-preview-literal-" });
      const directory = path.join(root, "assets#archive");
      yield* fileSystem.makeDirectory(directory);

      for (const name of [
        "icon#v2.png",
        "report#draft.pdf",
        "report.docx",
        "workbook.xlsx",
        "slides.pptx",
        "notes.odt",
        "budget.ods",
        "slides.odp",
        "notes.rtf",
        "book.epub",
        "analysis.ipynb",
        "specimen.ttf",
        "specimen.otf",
        "specimen.woff",
        "specimen.woff2",
        "image.bmp",
        "image.heic",
        "image.tif",
        "image.tiff",
      ]) {
        const filePath = path.join(directory, name);
        yield* fileSystem.writeFileString(filePath, "preview fixture");
        const canonicalFile = yield* fileSystem.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const token = suffix.slice(0, suffix.indexOf("/"));

        expect(yield* resolveAsset(token, name)).toEqual({ kind: "file", path: canonicalFile });
        if (name.endsWith(".png")) {
          expect(yield* resolveAsset(token, "other.png")).toBeNull();
        }
      }

      const disguisedPath = path.join(root, "image.png#notes.txt");
      yield* fileSystem.writeFileString(disguisedPath, "not an image");
      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: disguisedPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("signs MCP render intent only for inline HTML attachments", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const extension of ["html", "pdf"]) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000031-${extension}`;
        yield* fs.writeFileString(
          path.join(config.attachmentsDir, `${attachmentId}.${extension}`),
          "capture",
        );
        for (const disposition of ["inline", "attachment"] as const) {
          const result = yield* issueAssetUrl({
            resource: {
              _tag: "attachment",
              attachmentId,
              disposition,
              renderIntent: "mcp-app",
            },
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected attachment file");
          expect("renderIntent" in asset ? asset.renderIntent : undefined).toBe(
            extension === "html" && disposition === "inline" ? "mcp-app" : undefined,
          );
          const token = suffix.slice(0, separator);
          const [payload, signature] = token.split(".");
          const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
          claims.renderIntent = claims.renderIntent ? undefined : "mcp-app";
          const tampered = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
          expect(yield* resolveAsset(tampered, suffix.slice(separator + 1))).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect.skipIf(!symlinksSupported)(
    "reports image attachment dimensions when the attachments directory is a symlink",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachments-link-" });
        const realAttachmentsDir = path.join(root, "real");
        const linkedAttachmentsDir = path.join(root, "linked");
        yield* fs.makeDirectory(realAttachmentsDir);
        yield* fs.symlink(realAttachmentsDir, linkedAttachmentsDir);
        const attachmentId = "thread-1-00000000-0000-4000-8000-000000000041";
        yield* fs.writeFile(path.join(realAttachmentsDir, `${attachmentId}.png`), screenshotPng);

        const result = yield* issueAssetUrl({
          resource: { _tag: "attachment", attachmentId },
        }).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            attachmentsDir: linkedAttachmentsDir,
          }),
        );
        expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect("serves document attachments inline when a viewer requests it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const [extension, mimeType] of [
        ["pdf", "application/pdf"],
        ["svg", "image/svg+xml"],
        ["bmp", "image/bmp"],
        ["ttf", "font/ttf"],
        ["otf", "font/otf"],
        ["woff", "font/woff"],
        ["woff2", "font/woff2"],
        ["weba", "audio/webm"],
        ["zip", "application/zip"],
        ["jar", "application/java-archive"],
        ["tar", "application/x-tar"],
        ["gz", "application/gzip"],
        ["tgz", "application/gzip"],
        ["sqlite", "application/vnd.sqlite3"],
        ["sqlite3", "application/vnd.sqlite3"],
        ["db", "application/vnd.sqlite3"],
      ] as const) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000001-${extension}`;
        const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.${extension}`);
        yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

        const result = yield* issueAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId,
            fileName: `report.${extension}`,
            mimeType: "text/html",
            disposition: "inline",
          },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");

        expect(
          yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
        ).toEqual({
          kind: "file",
          path: attachmentPath,
          fileName: `report.${extension}`,
          mimeType,
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("keeps inline requests for other attachment types as downloads", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000002-7z";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.7z`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          fileName: "archive.7z",
          mimeType: "text/html",
          disposition: "inline",
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toMatchObject({ kind: "file", path: attachmentPath, download: true });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.sourcePath).toBe("favicon.svg");
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      expect(fallbackResult.sourcePath).toBeUndefined();
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("issues an exact capability for a saved favicon outside the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-workspace-",
      });
      const pictures = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-pictures-",
      });
      const externalPath = path.join(pictures, "custom.png");
      const siblingPath = path.join(pictures, "sibling.png");
      yield* fileSystem.writeFile(externalPath, new Uint8Array([1, 2, 3]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([4, 5, 6]));
      const canonicalPath = yield* fileSystem.realPath(externalPath);
      const canonicalSiblingPath = yield* fileSystem.realPath(siblingPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: externalPath,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(externalPath);
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-custom\.png$/);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({ kind: "file", path: canonicalPath });
      const tamperedSuffixResult = yield* resolveAsset(
        suffix.slice(0, separatorIndex),
        "sibling.png",
      );
      expect(tamperedSuffixResult).toEqual({ kind: "file", path: canonicalPath });
      expect(tamperedSuffixResult).not.toEqual({ kind: "file", path: canonicalSiblingPath });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("ignores a client favicon path hint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-hint-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "hint.svg"), "<svg>hint</svg>");
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root, path: "brand/hint.svg" },
        projectFaviconPath: "brand/saved.svg",
      });

      expect(result.sourcePath).toBe(path.join("brand", "saved.svg"));
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-saved\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("serves a host's credentialed media through that host's driver", () => {
    const fetched: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    const url = "https://github.com/owner/repo/blob/main/docs/shot.png";
    const media = sourceControlDefinitions.mediaUrl(url)!;
    const layerDrivers = Layer.succeed(BuiltInDrivers.SourceControlDrivers, [
      {
        driver: { kind: media.definition.kind, definition: media.definition },
        instance: fakeSourceControlDriverInstance(media.definition.kind, {
          pullRequests: null,
          fetchMedia: (request) =>
            Effect.sync(() => {
              fetched.push(request);
              return HttpClientResponse.fromWeb(
                HttpClientRequest.get(request.url),
                new Response("bytes", { status: 206, headers: { "content-length": "5" } }),
              );
            }),
        }),
      },
    ]);
    return Effect.gen(function* () {
      const decodeAssetCreateUrlInput = Schema.decodeEffect(AssetCreateUrlInput);

      // Every client and server release spells the resource this way on the wire.
      const { resource } = yield* decodeAssetCreateUrlInput({
        resource: { _tag: "github-media", cwd: "/repo", url },
      });
      const issued = yield* issueAssetUrl({ resource });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const asset = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      expect(asset).toEqual({
        kind: "source-control-media",
        url: media.fetchUrl,
        cwd: "/repo",
        expiresAt: issued.expiresAt,
      });
      if (asset?.kind !== "source-control-media") return;

      const response = yield* sourceControlMediaResponse(asset, {
        range: "bytes=0-4",
        cookie: "session",
      });
      expect(fetched).toEqual([{ url: media.fetchUrl, headers: { range: "bytes=0-4" } }]);
      expect(response.status).toBe(206);
      // The upstream sent no type, so it comes from the file name the host gave the media.
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-length"]).toBe("5");
    }).pipe(Effect.provide(Layer.merge(layerTest, layerDrivers)), Effect.scoped);
  });
  it.effect("refuses media no host keeps behind a credential, without echoing the URL", () =>
    Effect.gen(function* () {
      const encodeAssetAccessError = Schema.encodeEffect(Schema.fromJsonString(AssetAccessError));

      for (const url of [
        "https://example.com/shot.png",
        "https://example.com/shot.png?token=private-media-token",
      ]) {
        const error = yield* issueAssetUrl({
          resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetGitHubMediaUrlValidationError");
        const encoded = yield* encodeAssetAccessError(error);
        expect(encoded).not.toContain(url);
      }
    }).pipe(Effect.provide(layerTest)),
  );
});

