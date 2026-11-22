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

import * as AssetSigner from "./AssetSigner.ts";
import * as WorkspacePreviewRevisions from "./WorkspacePreviewRevisions.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { makeFakeWslHost } from "../testUtils/fakeWsl.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse } from "../http.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, readMcpAppHtml, resolveAsset } from "./AssetAccess.ts";
import * as ModelPreviews from "./ModelPreviews.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
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
  AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(layerConfig))),
  ),
  ModelPreviews.layerWith({ blender: "off" }).pipe(Layer.provide(layerConfig)),
  WorkspacePreviewRevisions.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("AssetAccess", () => {
  describe("readMcpAppHtml", () => {
    it.effect("accepts snapshots at the stored HTML byte limit", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        yield* fileSystem.writeFile(file, new Uint8Array(limit).fill(120));

        const bytes = yield* readMcpAppHtml(file);
        expect(bytes?.byteLength).toBe(limit);
        expect(bytes?.every((byte) => byte === 120)).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("rejects snapshots one byte past the limit and much larger files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        for (const size of [limit + 1, limit * 2]) {
          yield* fileSystem.writeFile(file, new Uint8Array(size).fill(120));
          expect(yield* readMcpAppHtml(file)).toBeNull();
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("preserves UTF-8 bytes across stream chunks and accepts empty snapshots", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        for (const html of ["", "<body>" + "☃".repeat(100_000) + "</body>"]) {
          const expected = new TextEncoder().encode(html);
          yield* fileSystem.writeFile(file, expected);
          const bytes = yield* readMcpAppHtml(file);
          expect(bytes?.byteLength).toBe(expected.byteLength);
          expect(bytes && new TextDecoder().decode(bytes)).toBe(html);
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    // regression: #17026 apply host color scheme to saved MCP apps
    it.effect("preserves filesystem failures instead of reporting oversized HTML", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const error = yield* readMcpAppHtml(path.join(directory, "missing.html")).pipe(Effect.flip);
        expect(error._tag).toBe("PlatformError");
        expect(error.reason._tag).toBe("NotFound");
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
  });

  it.effect("serves an image a tool returned inline from the stored item", () =>
    Effect.gen(function* () {
      const resource = {
        _tag: "tool-output-image" as const,
        threadId: screenshotItem.threadId,
        itemId: screenshotItem.id,
        index: 0,
      };
      const result = yield* issueAssetUrl({ resource });
      expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      expect(yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1))).toEqual({
        kind: "bytes",
        mimeType: "image/png",
        bytes: Buffer.from(screenshotPng),
      });
      const missing = yield* issueAssetUrl({ resource: { ...resource, index: 1 } }).pipe(
        Effect.flip,
      );
      expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
      const oversized = yield* issueAssetUrl({
        resource: { ...resource, itemId: oversizedScreenshotItem.id },
      }).pipe(Effect.flip);
      expect(oversized._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves previews of 3D files and downloads the originals", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-blend-root-" });
      // A legacy 64-bit header followed by a 2x1 thumbnail block.
      const blend = new Uint8Array(12 + 24 + 16);
      blend.set(new TextEncoder().encode("BLENDER-v300TEST"));
      const view = new DataView(blend.buffer);
      view.setInt32(16, 16, true);
      view.setInt32(36, 2, true);
      view.setInt32(40, 1, true);
      blend.set([255, 0, 0, 255, 0, 0, 0, 255], 44);
      const blendPath = path.join(root, "scene.blend");
      yield* fs.writeFile(blendPath, blend);
      const emptyPath = path.join(root, "empty.blend");
      yield* fs.writeFile(emptyPath, new TextEncoder().encode("BLENDER-v300ENDB"));
      const canonicalBlend = yield* fs.realPath(blendPath);
      const resolveUrl = (relativeUrl: string) => {
        const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      };
      const threadId = ThreadId.make("thread-1");

      for (const resource of [
        { _tag: "media-file" as const, threadId, path: blendPath },
        { _tag: "workspace-file" as const, threadId, path: "scene.blend" },
        { _tag: "draft-workspace-file" as const, cwd: root, path: "scene.blend" },
      ]) {
        const issued = yield* issueAssetUrl({ resource, workspaceRoot: root });
        const asset = yield* resolveUrl(issued.relativeUrl);
        expect(asset).toMatchObject({ kind: "bytes", mimeType: "image/png" });
        expect(asset?.kind === "bytes" && [...asset.bytes.subarray(1, 4)]).toEqual([
          0x50, 0x4e, 0x47,
        ]);
      }

      const stlPath = path.join(root, "part.stl");
      const stl = new Uint8Array(84 + 50);
      new DataView(stl.buffer).setUint32(80, 1, true);
      [0, 0, 0, 10, 0, 0, 0, 0, 10].forEach((value, index) =>
        new DataView(stl.buffer).setFloat32(96 + index * 4, value, true),
      );
      yield* fs.writeFile(stlPath, stl);
      const stlPreview = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", threadId, path: "part.stl" },
        workspaceRoot: root,
      });
      expect(yield* resolveUrl(stlPreview.relativeUrl)).toMatchObject({
        kind: "bytes",
        mimeType: "image/png",
      });

      const download = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId, path: blendPath, disposition: "attachment" },
        workspaceRoot: root,
      });
      expect(yield* resolveUrl(download.relativeUrl)).toMatchObject({
        kind: "file",
        path: canonicalBlend,
        download: true,
      });

      const draftDownload = yield* issueAssetUrl({
        resource: {
          _tag: "draft-workspace-file",
          cwd: root,
          path: "part.stl",
          disposition: "attachment",
        },
      });
      expect(yield* resolveUrl(draftDownload.relativeUrl)).toMatchObject({
        kind: "file",
        path: yield* fs.realPath(stlPath),
        download: true,
      });

      // Geometry is only for .blend files, and needs Blender, which this server has turned off.
      const geometry = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId, path: blendPath, disposition: "geometry" },
        workspaceRoot: root,
      });
      expect(yield* resolveUrl(geometry.relativeUrl)).toBeNull();
      const meshGeometry = yield* Effect.exit(
        issueAssetUrl({
          resource: { _tag: "media-file", threadId, path: stlPath, disposition: "geometry" },
          workspaceRoot: root,
        }),
      );
      expect(meshGeometry._tag).toBe("Failure");

      const empty = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId, path: emptyPath },
        workspaceRoot: root,
      });
      expect(yield* resolveUrl(empty.relativeUrl)).toBeNull();
      expect(new Uint8Array(yield* fs.readFile(blendPath))).toEqual(blend);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the background image published beside an environment theme", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(environmentThemesDir, { recursive: true });
      const imagePath = `${environmentThemesDir}/frieren.png`;
      yield* fs.writeFile(imagePath, screenshotPng);
      const result = yield* issueAssetUrl({
        resource: { _tag: "environment-theme-background", themeId: "frieren" },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
      expect(asset).toMatchObject({ kind: "file", path: yield* fs.realPath(imagePath) });
      if (asset?.kind !== "file") return;
      const response = yield* assetFileResponse(asset);
      expect(response.headers["content-type"]).toBe("image/png");

      yield* fs.remove(imagePath);
      expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("issues exact URLs for media and browser documents outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-outside-" });
      for (const [name, mimeType] of [
        ["screenshot.png", "image/png"],
        ["recording.mp4", "video/mp4"],
        ["recording.webm", "video/webm"],
        ["report.html", "text/html"],
        ["report.pdf", "application/pdf"],
        ["notes.odt", "application/vnd.oasis.opendocument.text"],
        ["budget.ods", "application/vnd.oasis.opendocument.spreadsheet"],
        ["slides.odp", "application/vnd.oasis.opendocument.presentation"],
        ["notes.rtf", "application/rtf"],
        ["book.epub", "application/epub+zip"],
        ["analysis.ipynb", "application/x-ipynb+json"],
        ["tone.wav", "audio/wav"],
        ["tone.webm-audio", "audio/webm"],
        ["archive.zip", "application/zip"],
        ["archive.jar", "application/java-archive"],
        ["archive.tar", "application/x-tar"],
        ["archive.gz", "application/gzip"],
        ["archive.tgz", "application/gzip"],
        ["data.sqlite", "application/vnd.sqlite3"],
        ["data.sqlite3", "application/vnd.sqlite3"],
        ["data.db", "application/vnd.sqlite3"],
      ] as const) {
        const filePath = path.join(outside, name);
        yield* fs.writeFileString(filePath, "media");
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toMatchObject({
          kind: "file",
          path: canonicalFile,
          mimeType,
        });
        yield* fs.writeFileString(path.join(outside, "sibling.png"), "private sibling");
        expect(yield* resolveAsset(token, "sibling.png")).toBeNull();
        expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("downloads any linked file with the same exact-file identity checks as media", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-outside-" });
      for (const name of [
        "data.csv",
        "report.docx",
        "sheet.xlsx",
        "slides.pptx",
        "archive.zip",
        "no-extension",
      ]) {
        for (const [directory, draft] of [
          [root, false],
          [outside, false],
          [root, true],
          [outside, true],
        ] as const) {
          const filePath = path.join(directory, name);
          yield* fs.writeFileString(filePath, "shared file bytes");
          const requested = directory === root ? name : filePath;
          const resource = draft
            ? {
                _tag: "draft-workspace-file" as const,
                cwd: root,
                path: requested,
                disposition: "attachment" as const,
              }
            : {
                _tag: "media-file" as const,
                threadId: ThreadId.make("thread-1"),
                path: requested,
                disposition: "attachment" as const,
              };
          const result = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const token = suffix.slice(0, separator);
          const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
          expect(asset).toMatchObject({
            kind: "file",
            download: true,
            fileName: name,
            mimeType: "application/octet-stream",
          });
          if (asset?.kind !== "file") throw new Error("Expected a downloadable file");
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
          expect(response.headers.get("content-disposition")).toContain("attachment;");
          expect(response.headers.get("content-type")).toBe("application/octet-stream");
          expect(yield* Effect.promise(() => response.text())).toBe("shared file bytes");
          expect(yield* resolveAsset(token, "sibling.docx")).toBeNull();
          expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
          expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
          yield* fs.rename(filePath, `${filePath}.original`);
          yield* fs.writeFileString(filePath, "replacement bytes");
          expect(yield* resolveAsset(token, name)).toBeNull();
        }
      }
      const directoryError = yield* issueAssetUrl({
        resource: {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: root,
          disposition: "attachment",
        },
      }).pipe(Effect.flip);
      expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves relative media paths from the thread workspace, including outside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-relative-" });
      const root = path.join(directory, "workspace");
      yield* fs.makeDirectory(root);
      for (const relativePath of ["screenshot.png", "../recording.mp4"]) {
        const filePath = path.resolve(root, relativePath);
        yield* fs.writeFileString(filePath, "media");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: relativePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
        ).toMatchObject({
          kind: "file",
          path: yield* fs.realPath(filePath),
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("previews draft audio and video from relative workspace paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-media-" });
      for (const [name, mimeType] of [
        ["video.mp4", "video/mp4"],
        ["audio.wav", "audio/wav"],
      ] as const) {
        const filePath = path.join(root, name);
        yield* fs.writeFileString(filePath, "media bytes");
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: name },
          workspaceRoot: root,
        });
        expect(result.fileRevision).toEqual(expect.any(String));
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
        expect(asset).toMatchObject({ kind: "file", path: yield* fs.realPath(filePath), mimeType });
        if (asset?.kind !== "file") throw new Error("Expected draft media file");
        for (const [range, status, body] of [
          [undefined, 200, "media bytes"],
          ["bytes=2-5", 206, "dia "],
        ] as const) {
          const resolved = yield* resolveAsset(token, suffix.slice(separator + 1));
          if (resolved?.kind !== "file") throw new Error("Expected draft media file");
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(resolved, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-type")).toBe(mimeType);
          expect(response.headers.get("content-length")).toBe(String(body.length));
          if (range) expect(response.headers.get("content-range")).toBe("bytes 2-5/11");
          expect(yield* Effect.promise(() => response.text())).toBe(body);
        }
        for (const requestedPath of [
          name === "video.mp4" ? "audio.wav" : "video.mp4",
          `../${name}`,
        ]) {
          expect(yield* resolveAsset(token, requestedPath)).toBeNull();
        }
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "rejects draft media escapes and disallowed types without enabling non-draft media",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-boundary-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        for (const name of ["video.mp4", "audio.wav", "secret.txt"]) {
          yield* fs.writeFileString(path.join(root, name), "workspace bytes");
          yield* fs.writeFileString(path.join(directory, name), "outside bytes");
        }
        for (const [requestedPath, tag] of [
          ["../video.mp4", "AssetWorkspacePathValidationError"],
          ["../audio.wav", "AssetWorkspacePathValidationError"],
          ["secret.txt", "AssetPreviewTypeValidationError"],
        ] as const) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: requestedPath },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe(tag);
        }
        for (const name of ["video.mp4", "audio.wav"]) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("AssetPreviewTypeValidationError");
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects draft media symlinks escaping the workspace or targeting disallowed types",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-symlink-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const outside = path.join(directory, "outside.mp4");
        const secret = path.join(root, "secret.txt");
        yield* fs.writeFileString(outside, "outside bytes");
        yield* fs.writeFileString(secret, "private bytes");
        for (const [name, target] of [
          ["escape.mp4", outside],
          ["disguised.wav", secret],
        ] as const) {
          yield* fs.symlink(target, path.join(root, name));
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(["AssetWorkspaceAssetNotFoundError", "AssetPreviewTypeValidationError"]).toContain(
            error._tag,
          );
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "preserves absolute draft previews through stable symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-absolute-" });
        for (const extension of ["png", "mp4", "wav"]) {
          const target = path.join(root, `target.${extension}`);
          const alias = path.join(root, `alias.${extension}`);
          yield* fs.writeFileString(target, "preview bytes");
          yield* fs.symlink(target, alias);
          const result = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: alias },
            workspaceRoot: root,
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          expect(
            yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
          ).toMatchObject({ kind: "file", path: yield* fs.realPath(target) });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a draft media path swapped after workspace containment validation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-swap-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const filePath = path.join(root, "video.mp4");
        const outside = path.join(directory, "outside.mp4");
        yield* fs.writeFileString(filePath, "workspace video");
        yield* fs.writeFileString(outside, "outside video");
        const canonicalFile = yield* fs.realPath(filePath);
        let swapped = false;
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalFile && !swapped) {
              swapped = true;
              yield* fs.remove(filePath);
              yield* fs.symlink(outside, filePath);
            }
            return info;
          }),
        });
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: "video.mp4" },
          workspaceRoot: root,
        }).pipe(Effect.result, Effect.provideService(FileSystem.FileSystem, swappingFileSystem));
        expect(swapped).toBe(true);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AssetWorkspaceAssetNotFoundError" },
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["media-file", "draft-workspace-file"] as const)(
    "resolves home-relative %s paths independently of the workspace",
    (tag) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-home-" });
        const home = path.join(directory, "var", "home", "alice");
        const filePath = path.join(home, "Downloads", "repro.mp4");
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, "recording bytes");
        const canonicalFile = yield* fs.realPath(filePath);
        yield* Effect.gen(function* () {
          for (const workspaceRoot of [
            path.join(home, "project"),
            path.join(directory, "srv", "project"),
            undefined,
          ]) {
            if (workspaceRoot) yield* fs.makeDirectory(workspaceRoot, { recursive: true });
            for (const requestedPath of ["~/Downloads/repro.mp4", "~\\Downloads/repro.mp4"]) {
              const result = yield* issueAssetUrl({
                resource: {
                  ...(tag === "media-file"
                    ? { _tag: tag, threadId: ThreadId.make("thread-1") }
                    : { _tag: tag, cwd: workspaceRoot ?? directory }),
                  path: requestedPath,
                },
                ...(workspaceRoot ? { workspaceRoot } : {}),
              });
              const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
              const separator = suffix.indexOf("/");
              const asset = yield* resolveAsset(
                suffix.slice(0, separator),
                suffix.slice(separator + 1),
              );
              expect(asset).toMatchObject({
                kind: "file",
                path: canonicalFile,
                mimeType: "video/mp4",
              });
              if (asset?.kind !== "file") throw new Error("Expected a resolved home media file");
              const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
              expect(yield* Effect.promise(() => response.text())).toBe("recording bytes");
            }
          }
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "resolves a Windows drive media path under WSL to where wslpath mounts it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { mountRoot, underWsl } = yield* makeFakeWslHost;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-wsl-root-" });
        const filePath = path.join(mountRoot, "c", "Users", "me", "Pictures", "shot.png");
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFile(filePath, screenshotPng);
        const canonicalFile = yield* fs.realPath(filePath);
        const drivePath = "C:\\Users\\me\\Pictures\\shot.png";

        for (const resource of [
          { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: drivePath },
          { _tag: "draft-workspace-file", cwd: workspaceRoot, path: drivePath },
        ] as const) {
          const result = yield* underWsl(issueAssetUrl({ resource, workspaceRoot }));
          expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          expect(
            yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
          ).toMatchObject({ kind: "file", path: canonicalFile, mimeType: "image/png" });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  // Agents on Windows copy paths from Git Bash, which prints `C:\x` as `/c/x`.
  it.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "resolves a Git Bash drive media path on Windows",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-gitbash-" });
        const canonicalFile = path.join(yield* fs.realPath(workspaceRoot), "shot.png");
        yield* fs.writeFile(canonicalFile, screenshotPng);
        const gitBashPath = `/${canonicalFile[0]!.toLowerCase()}${canonicalFile.slice(2).replaceAll("\\", "/")}`;

        for (const resource of [
          { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: gitBashPath },
          { _tag: "draft-workspace-file", cwd: workspaceRoot, path: gitBashPath },
        ] as const) {
          const result = yield* issueAssetUrl({ resource, workspaceRoot });
          expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          expect(
            yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
          ).toMatchObject({ kind: "file", path: canonicalFile, mimeType: "image/png" });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  // Resolving `file://attacker.test/share/cat.jpg` from an agent's markdown sent the
  // Windows user's NTLM credentials to attacker.test.
  it.effect("never resolves a network media path outside the thread's project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolved: Array<string> = [];
      const recordingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        realPath: (requestedPath) => {
          resolved.push(requestedPath);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: requestedPath,
            }),
          );
        },
      });
      const share = "//nas.test/share/project";
      for (const resource of [
        {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: "//attacker.test/s/a.png",
        },
        { _tag: "draft-workspace-file", cwd: share, path: "//attacker.test/s/a.png" },
        { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: `${share}/a.png` },
      ] as const) {
        const error = yield* issueAssetUrl({ resource, workspaceRoot: share }).pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
          Effect.flip,
        );
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }
      expect(resolved).toEqual([path.resolve(`${share}/a.png`)]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects non-previewable files, disguised targets, and directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-validation-" });
        for (const name of ["report.md", "secret.txt", "secret.%70ng", "secret.png#private.txt"]) {
          const filePath = path.join(root, name);
          yield* fs.writeFileString(filePath, "not media");
          const error = yield* issueAssetUrl({
            resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
        }
        const disguisedPath = path.join(root, "disguised.png");
        yield* fs.symlink(path.join(root, "secret.txt"), disguisedPath);
        const disguisedError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: disguisedPath,
          },
        }).pipe(Effect.flip);
        expect(disguisedError).toBeInstanceOf(AssetPreviewTypeValidationError);
        const directoryPath = path.join(root, "directory.png");
        yield* fs.makeDirectory(directoryPath);
        const directoryError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: directoryPath,
          },
        }).pipe(Effect.flip);
        expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "serves a linked workspace file only while its target is previewable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-link-" }));
        yield* fs.writeFileString(path.join(root, "payload.xhtml"), "<html/>");
        yield* fs.writeFileString(path.join(root, "real.pdf"), "%PDF-1.4");
        const link = path.join(root, "report.pdf");
        const issue = issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "report.pdf",
          },
          workspaceRoot: root,
        });
        const resolveIssued = (relativeUrl: string) => {
          const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
        };

        yield* fs.symlink(path.join(root, "payload.xhtml"), link);
        expect((yield* issue.pipe(Effect.flip))._tag).toBe("AssetPreviewTypeValidationError");

        yield* fs.remove(link);
        yield* fs.symlink(path.join(root, "real.pdf"), link);
        const issued = yield* issue;
        expect(yield* resolveIssued(issued.relativeUrl)).toMatchObject({
          path: path.join(root, "real.pdf"),
        });

        yield* fs.remove(link);
        yield* fs.symlink(path.join(root, "payload.xhtml"), link);
        expect(yield* resolveIssued(issued.relativeUrl)).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("does not issue URLs for server state files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const stateFile = path.join(config.secretsDir, "example.bin");
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      yield* fs.writeFile(stateFile, new Uint8Array(32).fill(7));
      yield* fs.writeFileString(config.dbPath, "SQLite format 3");
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-state-" });
      const alias = path.join(root, "alias");
      yield* fs.symlink(stateFile, alias);
      const threadId = ThreadId.make("thread-1");
      for (const resource of [
        { _tag: "media-file", threadId, path: stateFile, disposition: "attachment" },
        { _tag: "media-file", threadId, path: alias, disposition: "attachment" },
        {
          _tag: "media-file",
          threadId,
          path: path.join(config.secretsDir, "..", "secrets", "example.bin"),
          disposition: "attachment",
        },
        { _tag: "media-file", threadId, path: config.dbPath },
        { _tag: "draft-workspace-file", cwd: config.stateDir, path: "statev2.sqlite" },
        {
          _tag: "draft-workspace-file",
          cwd: config.stateDir,
          path: "statev2.sqlite",
          disposition: "attachment",
        },
      ] as const) {
        const error = yield* issueAssetUrl({ resource }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }

      const icon = path.join(config.baseDir, "icon.png");
      yield* fs.symlink(stateFile, icon);
      yield* fs.writeFileString(path.join(config.baseDir, "page.html"), '<img src="icon.png">');
      const page = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: config.baseDir, path: "page.html" },
      });
      const pageToken = page.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length).split("/")[0]!;
      expect(yield* resolveAsset(pageToken, "icon.png")).toBeNull();
      const faviconError = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: icon,
      }).pipe(Effect.flip);
      expect(faviconError._tag).toBe("AssetProjectFaviconNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "binds media URLs to the canonical target and rejects symlink substitution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-symlink-" });
        const filePath = path.join(root, "actual.svg");
        const aliasPath = path.join(root, "alias.png");
        const replacementPath = path.join(root, "other.svg");
        yield* fs.writeFileString(filePath, "<svg/>");
        yield* fs.writeFileString(replacementPath, "<svg>private</svg>");
        yield* fs.symlink(filePath, aliasPath);
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: aliasPath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const name = suffix.slice(separator + 1);
        const expected = { kind: "file", path: canonicalFile, mimeType: "image/svg+xml" };
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(aliasPath);
        yield* fs.symlink(replacementPath, aliasPath);
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(filePath);
        yield* fs.symlink(replacementPath, filePath);
        expect(yield* resolveAsset(token, name)).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps full and partial responses bound to the file opened during resolution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-file-" });
        const filePath = path.join(root, "recording.mp4");
        const savedPath = path.join(root, "saved.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "0123456789");
        yield* fs.writeFileString(secretPath, "private information");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        for (const [range, expected, status] of [
          [undefined, "0123456789", 200],
          ["bytes=2-5", "2345", 206],
        ] as const) {
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected a resolved media file");

          yield* fs.rename(filePath, savedPath);
          yield* fs.symlink(secretPath, filePath);
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-length")).toBe(String(expected.length));
          expect(yield* Effect.promise(() => response.text())).toBe(expected);
          yield* fs.remove(filePath);
          yield* fs.rename(savedPath, filePath);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a symlink swapped in after canonical validation but before open",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-race-" });
        const filePath = path.join(root, "recording.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "video");
        yield* fs.writeFileString(secretPath, "secret");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.remove(filePath);
              yield* fs.symlink(secretPath, filePath);
            }
            return info;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects an ancestor symlink race even when canonical path rechecks would pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-parent-race-" });
        const publicDirectory = path.join(root, "public");
        const privateDirectory = path.join(root, "private");
        yield* fs.makeDirectory(publicDirectory);
        yield* fs.makeDirectory(privateDirectory);
        const filePath = path.join(publicDirectory, "recording.mp4");
        yield* fs.writeFileString(filePath, "public video");
        yield* fs.writeFileString(path.join(privateDirectory, "recording.mp4"), "private video");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const native = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const savedDirectory = path.join(root, "saved");
        const realpathSpy = vi.mocked(NodeFSP.realpath).mockImplementationOnce(async () => {
          await native.unlink(publicDirectory);
          await native.rename(savedDirectory, publicDirectory);
          const canonical = await native.realpath(canonicalPath);
          await native.rename(publicDirectory, savedDirectory);
          await native.symlink(privateDirectory, publicDirectory, "junction");
          return canonical;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => realpathSpy.mockReset().mockImplementation(native.realpath)),
        );
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          realPath: Effect.fn(function* (requestedPath) {
            const canonical = yield* fs.realPath(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.rename(publicDirectory, savedDirectory);
              yield* Effect.promise(() =>
                NodeFSP.symlink(privateDirectory, publicDirectory, "junction"),
              );
            }
            return canonical;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("versions media by file changes rather than by re-signing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-revision-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      yield* Effect.promise(() => NodeFSP.utimes(filePath, 1_000, 1_000));
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      expect(original.fileRevision).toEqual(expect.any(String));

      yield* TestClock.adjust("1 minute");
      const renewed = yield* issueAssetUrl(input);
      expect(renewed.relativeUrl).not.toBe(original.relativeUrl);
      expect(renewed.fileRevision).toBe(original.fileRevision);

      yield* fs.writeFileString(filePath, "modified");
      yield* Effect.promise(() => NodeFSP.utimes(filePath, 2_000, 2_000));
      const edited = yield* issueAssetUrl(input);
      expect(edited.fileRevision).not.toBe(original.fileRevision);

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "modified");
      yield* Effect.promise(() => NodeFSP.utimes(replacement, 2_000, 2_000));
      yield* fs.rename(replacement, filePath);
      const replaced = yield* issueAssetUrl(input);
      expect(replaced.fileRevision).not.toBe(edited.fileRevision);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps in-place edits readable but requires a new URL after atomic replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-replacement-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      const suffix = original.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const name = suffix.slice(separator + 1);
      yield* fs.writeFileString(filePath, "in-place edit");
      const edited = yield* resolveAsset(token, name);
      if (edited?.kind !== "file") throw new Error("Expected the edited media file");
      const editedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(edited));
      expect(yield* Effect.promise(() => editedResponse.text())).toBe("in-place edit");

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "replacement");
      yield* fs.rename(replacement, filePath);
      expect(yield* resolveAsset(token, name)).toBeNull();

      const renewed = yield* issueAssetUrl(input);
      const renewedSuffix = renewed.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const renewedSeparator = renewedSuffix.indexOf("/");
      const renewedAsset = yield* resolveAsset(
        renewedSuffix.slice(0, renewedSeparator),
        renewedSuffix.slice(renewedSeparator + 1),
      );
      if (renewedAsset?.kind !== "file") throw new Error("Expected the replacement media file");
      const renewedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(renewedAsset));
      expect(yield* Effect.promise(() => renewedResponse.text())).toBe("replacement");
      yield* fs.remove(filePath);
      expect(
        yield* resolveAsset(
          renewedSuffix.slice(0, renewedSeparator),
          renewedSuffix.slice(renewedSeparator + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("validates canonical preview dependency paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const page = path.join(root, "report.html");
      yield* fs.writeFileString(page, "<!doctype html>");
      for (const name of ["report.css", ".internal.css", "notes.txt"]) {
        yield* fs.writeFileString(path.join(root, name), "fixture");
      }
      yield* fs.symlink(path.join(root, "report.css"), path.join(root, "theme.css"));
      yield* fs.symlink(path.join(root, ".internal.css"), path.join(root, "internal.css"));
      yield* fs.symlink(path.join(root, "notes.txt"), path.join(root, "notes.css"));

      const result = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: page },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(ASSET_ROUTE_PREFIX.length + 1);
      const token = suffix.slice(0, suffix.indexOf("/"));
      expect(yield* resolveAsset(token, "theme.css")).toMatchObject({
        path: yield* fs.realPath(path.join(root, "report.css")),
      });
      expect(yield* resolveAsset(token, "internal.css")).toBeNull();
      expect(yield* resolveAsset(token, "notes.css")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "validates canonical sibling assets for previews in dot-prefixed folders",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const reportsDirectory = path.join(root, ".reports");
        yield* fs.makeDirectory(path.join(reportsDirectory, ".cache"), { recursive: true });
        yield* fs.makeDirectory(path.join(root, ".secret"));
        const page = path.join(reportsDirectory, "report.html");
        yield* fs.writeFileString(page, "<!doctype html>");
        const dependencies = [
          { name: "linked.css", target: path.join(root, ".secret", "key.css"), allowed: false },
          {
            name: "inner.css",
            target: path.join(reportsDirectory, ".cache", "hidden.css"),
            allowed: false,
          },
          { name: "shared.css", target: path.join(root, "shared.css"), allowed: true },
        ];
        for (const { name, target } of dependencies) {
          yield* fs.writeFileString(target, "fixture");
          yield* fs.symlink(target, path.join(reportsDirectory, name));
        }
        const result = yield* issueAssetUrl({
          resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: page },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(ASSET_ROUTE_PREFIX.length + 1);
        const token = suffix.slice(0, suffix.indexOf("/"));
        for (const { name, target, allowed } of dependencies) {
          const resolved = yield* resolveAsset(token, name);
          if (allowed) {
            expect(resolved).toEqual({
              kind: "file",
              path: yield* fs.realPath(target),
              renderIntent: "file-preview",
            });
          } else {
            expect(resolved).toBeNull();
          }
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
        renderIntent: "file-preview",
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
        renderIntent: "file-preview",
      });
      yield* fileSystem.makeDirectory(path.join(root, "clips"));
      for (const mediaName of ["clips/clip.mp4", "clips/clip.webm", "clips/clip.mp3"]) {
        const mediaPath = path.join(root, mediaName);
        yield* fileSystem.writeFileString(mediaPath, "media bytes");
        expect(yield* resolveAsset(token, mediaName)).toMatchObject({
          kind: "file",
          path: yield* fileSystem.realPath(mediaPath),
        });
      }
      for (const extension of ["otf", "ttf", "woff", "woff2"]) {
        const fontName = `preview.${extension}`;
        const fontPath = path.join(root, fontName);
        yield* fileSystem.writeFileString(fontPath, "font bytes");
        const canonicalFontPath = yield* fileSystem.realPath(fontPath);
        for (const resource of [
          { _tag: "workspace-file" as const, threadId: ThreadId.make("thread-1"), path: htmlPath },
          { _tag: "draft-workspace-file" as const, cwd: root, path: "report.html" },
        ]) {
          const url = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = url.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          expect(yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), fontName)).toEqual({
            kind: "file",
            path: canonicalFontPath,
            renderIntent: "file-preview",
          });
        }
      }
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();

      const reportsDirectory = path.join(root, ".reports");
      yield* fileSystem.makeDirectory(path.join(reportsDirectory, ".cache"), { recursive: true });
      const dotHtmlPath = path.join(reportsDirectory, "report.html");
      const dotCssPath = path.join(reportsDirectory, "report.css");
      yield* fileSystem.writeFileString(dotHtmlPath, "<h1>Quarterly report</h1>");
      yield* fileSystem.writeFileString(dotCssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(reportsDirectory, ".cache", "hidden.css"), "");
      const dotUrl = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: dotHtmlPath,
        },
        workspaceRoot: root,
      });
      const dotSuffix = dotUrl.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const dotToken = dotSuffix.slice(0, dotSuffix.indexOf("/"));
      expect(yield* resolveAsset(dotToken, "report.html")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(dotHtmlPath),
        renderIntent: "file-preview",
      });
      expect(yield* resolveAsset(dotToken, "report.css")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(dotCssPath),
        renderIntent: "file-preview",
      });
      expect(yield* resolveAsset(dotToken, ".cache/hidden.css")).toBeNull();
      for (const extension of [
        "odt",
        "ods",
        "odp",
        "rtf",
        "epub",
        "ipynb",
        "zip",
        "jar",
        "tar",
        "gz",
        "tgz",
        "sqlite",
        "sqlite3",
        "db",
        "docx",
        "xlsx",
        "pptx",
        "bmp",
        "heic",
        "tif",
        "tiff",
        "weba",
        "mmd",
        "mermaid",
      ]) {
        const siblingName = `private.${extension}`;
        yield* fileSystem.writeFileString(path.join(root, siblingName), "private sibling");
        for (const resource of [
          { _tag: "workspace-file" as const, threadId: ThreadId.make("thread-1"), path: htmlPath },
          { _tag: "draft-workspace-file" as const, cwd: root, path: "report.html" },
        ]) {
          const url = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = url.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          expect(yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), siblingName)).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("moves an HTML preview's revision only for the page and the files it requested", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-asset-revision-" });
      const pages = path.join(root, "pages");
      yield* fileSystem.makeDirectory(pages);
      const write = (name: string, text: string) =>
        fileSystem.writeFileString(path.join(pages, name), text);
      yield* write("a.html", '<link rel="stylesheet" href="a.css"><script src="late.js"></script>');
      yield* write("a.css", "body { color: red; }");
      yield* write("b.html", "<h1>b</h1>");
      const mint = (name: string) =>
        issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: path.join(pages, name),
          },
          workspaceRoot: root,
        });
      const load = Effect.fn(function* (name: string, requests: ReadonlyArray<string>) {
        const { relativeUrl } = yield* mint(name);
        const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        for (const request of requests) {
          yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), request);
        }
      });
      const revisions = Effect.fn(function* () {
        return [(yield* mint("a.html")).fileRevision, (yield* mint("b.html")).fileRevision];
      });

      // Two tabs each load a page; a.html also asks for a script that does not exist yet.
      const opened = yield* revisions();
      expect(opened[0]).toBeDefined();
      expect(opened[1]).not.toBe(opened[0]);
      yield* load("a.html", ["a.html", "a.css", "late.js"]);
      yield* load("b.html", ["b.html"]);
      expect(yield* revisions()).toEqual(opened);

      // Files no page asked for leave both previews alone.
      yield* write("unrelated.css", "p {}");
      yield* fileSystem.writeFileString(path.join(root, "notes.md"), "notes");
      expect(yield* revisions()).toEqual(opened);

      // An edit to one page leaves the page beside it alone.
      yield* write("b.html", "<h1>B</h1>");
      const afterPageEdit = yield* revisions();
      expect(afterPageEdit[0]).toBe(opened[0]);
      expect(afterPageEdit[1]).not.toBe(opened[1]);

      // A same-size edit to a requested stylesheet reloads only the page that uses it.
      yield* write("a.css", "body { color: blue }");
      const afterStyleEdit = yield* revisions();
      expect(afterStyleEdit[0]).not.toBe(afterPageEdit[0]);
      expect(afterStyleEdit[1]).toBe(afterPageEdit[1]);

      // So does a requested file that appears, and one that goes away.
      yield* write("late.js", "document.title = 'late';");
      const afterCreate = yield* revisions();
      expect(afterCreate[0]).not.toBe(afterStyleEdit[0]);
      yield* fileSystem.remove(path.join(pages, "a.css"));
      const afterRemove = yield* revisions();
      expect(afterRemove[0]).not.toBe(afterCreate[0]);
      expect(afterRemove[1]).toBe(afterPageEdit[1]);

      // Overlapping mints after one edit agree, so the edit reloads the page once.
      yield* write("late.js", "document.title = 'later';");
      const overlapping = yield* Effect.all(
        Array.from({ length: 8 }, () => mint("a.html")),
        { concurrency: "unbounded" },
      );
      expect(new Set(overlapping.map((minted) => minted.fileRevision)).size).toBe(1);
      expect(overlapping[0]?.fileRevision).not.toBe(afterRemove[0]);

      // A page that loads more files than are tracked falls back to the client's own reloads.
      yield* load(
        "b.html",
        Array.from(
          { length: WorkspacePreviewRevisions.MAX_TRACKED_FILES_PER_DOCUMENT },
          (_, index) => `chunk-${index}.js`,
        ),
      );
      expect((yield* mint("b.html")).fileRevision).toBeUndefined();
      expect((yield* mint("a.html")).fileRevision).toBe(overlapping[0]?.fileRevision);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact workspace URLs for every non-HTML preview", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(assetsDirectory, "private.docx"),
        "private document",
      );
      for (const extension of [
        "pdf",
        "odt",
        "ods",
        "odp",
        "rtf",
        "epub",
        "ipynb",
        "png",
        "bmp",
        "heic",
        "tif",
        "tiff",
        "docx",
        "xlsx",
        "pptx",
        "ttf",
        "otf",
        "woff",
        "woff2",
        "zip",
        "jar",
        "tar",
        "gz",
        "tgz",
        "sqlite",
        "sqlite3",
        "db",
      ]) {
        const name = `preview.${extension}`;
        const filePath = path.join(assetsDirectory, name);
        const siblingName = `other.${extension}`;
        yield* fileSystem.writeFileString(filePath, "preview");
        yield* fileSystem.writeFileString(
          path.join(assetsDirectory, siblingName),
          "private sibling",
        );
        const canonicalPath = yield* fileSystem.realPath(filePath);
        for (const resource of [
          {
            _tag: "workspace-file" as const,
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          { _tag: "draft-workspace-file" as const, cwd: root, path: `assets/${name}` },
        ]) {
          const result = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const token = suffix.slice(0, suffix.indexOf("/"));
          expect(yield* resolveAsset(token, name)).toEqual({ kind: "file", path: canonicalPath });
          expect(yield* resolveAsset(token, siblingName)).toBeNull();
          expect(yield* resolveAsset(token, "private.docx")).toBeNull();
          expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

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

  it.effect("preserves the change request repository through RPC decoding and signed media", () =>
    Effect.gen(function* () {
      const decodeAssetCreateUrlInput = Schema.decodeEffect(AssetCreateUrlInput);
      const resource = {
        _tag: SOURCE_CONTROL_MEDIA_ASSET,
        cwd: "/personal-fork",
        url: "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
        repository: "enterprise/private",
      };
      const input = yield* decodeAssetCreateUrlInput({ resource });
      const issued = yield* issueAssetUrl(input);
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const resolved = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));

      expect(resolved).toEqual({
        kind: "source-control-media",
        url: resource.url,
        cwd: resource.cwd,
        repository: resource.repository,
        expiresAt: issued.expiresAt,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves a host's credentialed media through that host's driver", () => {
    const fetched: Array<{
      url: string;
      headers: Readonly<Record<string, string>>;
      repository?: string;
    }> = [];
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
    // Clients that predate `repository` get the checkout's.
    const layerIdentities = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () =>
        Effect.succeed({
          canonicalKey: "github.com/owner/repo",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
          provider: media.definition.kind,
          owner: "owner",
          name: "repo",
        }),
    });
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
      expect(fetched).toEqual([
        { url: media.fetchUrl, headers: { range: "bytes=0-4" }, repository: "owner/repo" },
      ]);
      expect(response.status).toBe(206);
      // The upstream sent no type, so it comes from the file name the host gave the media.
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-length"]).toBe("5");

      // A pull request's own repository wins over the checkout it is shown in.
      yield* sourceControlMediaResponse({ ...asset, repository: "enterprise/private" }, {});
      expect(fetched.at(-1)?.repository).toBe("enterprise/private");
    }).pipe(Effect.provide(Layer.mergeAll(layerTest, layerDrivers, layerIdentities)));
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
