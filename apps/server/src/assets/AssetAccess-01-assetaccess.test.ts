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
        for (const directory of [root, outside]) {
          const filePath = path.join(directory, name);
          yield* fs.writeFileString(filePath, "shared file bytes");
          const resource = {
            _tag: "media-file" as const,
            threadId: ThreadId.make("thread-1"),
            path: directory === root ? name : filePath,
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
  it.effect("resolves home-relative media paths independently of the workspace", () =>
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
                _tag: "media-file",
                threadId: ThreadId.make("thread-1"),
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
});

