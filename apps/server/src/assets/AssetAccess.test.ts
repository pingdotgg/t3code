import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ProjectFaviconResolver } from "../project/Services/ProjectFaviconResolver.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const testLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(
    Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        get: () => Effect.succeed(null),
        set: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
        remove: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProjectFaviconResolver,
      ProjectFaviconResolver.of({ resolvePath: () => Effect.succeed(null) }),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ServerConfig, {} as ServerConfigShape)),
  Layer.provideMerge(NodeServices.layer),
);

const withWorkspace = <A, E, R>(
  use: (workspaceRoot: string, outsideRoot: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureRoot = path.join(process.cwd(), `.asset-access-${randomUUID()}`);
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const outsideRoot = path.join(fixtureRoot, "outside");
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
    yield* fileSystem.makeDirectory(outsideRoot, { recursive: true });
    return yield* use(workspaceRoot, outsideRoot).pipe(
      Effect.ensuring(fileSystem.remove(fixtureRoot, { recursive: true }).pipe(Effect.ignore)),
    );
  });

function tokenFromRelativeUrl(relativeUrl: string): string {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  return suffix.slice(0, suffix.indexOf("/"));
}

describe("AssetAccess", () => {
  it.effect("issues a workspace capability for browser bytes and permitted sibling assets", () =>
    withWorkspace((workspaceRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const htmlPath = path.join(workspaceRoot, "report.html");
        const cssPath = path.join(workspaceRoot, "report.css");
        const pdfPath = path.join(workspaceRoot, "report.pdf");
        yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
        yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
        yield* fileSystem.writeFile(pdfPath, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));

        const htmlUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "report.html",
          },
          workspaceRoot,
        });
        const pdfUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "report.pdf",
          },
          workspaceRoot,
        });

        expect(
          yield* resolveAsset(tokenFromRelativeUrl(htmlUrl.relativeUrl), "report.html"),
        ).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(htmlPath),
        });
        expect(
          yield* resolveAsset(tokenFromRelativeUrl(htmlUrl.relativeUrl), "report.css"),
        ).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(cssPath),
        });
        expect(yield* resolveAsset(tokenFromRelativeUrl(pdfUrl.relativeUrl), "report.pdf")).toEqual(
          {
            kind: "file",
            path: yield* fileSystem.realPath(pdfPath),
          },
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a workspace path that escapes through a symlink", () =>
    withWorkspace((workspaceRoot, outsideRoot) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outsideFile = path.join(outsideRoot, "escape.html");
        yield* fileSystem.writeFileString(outsideFile, "<p>outside</p>");
        yield* Effect.promise(() => symlink(outsideFile, path.join(workspaceRoot, "escape.html")));

        const error = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "escape.html",
          },
          workspaceRoot,
        }).pipe(Effect.flip);

        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
