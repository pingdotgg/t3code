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
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
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
          });
        }
      }
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
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
});

