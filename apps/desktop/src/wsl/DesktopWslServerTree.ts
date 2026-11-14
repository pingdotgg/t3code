import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

// WSL's plain Node cannot read server.asar. Electron's patched fs also reads its unpacked native siblings.

export type WslServerTreeResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: string; readonly fatal: boolean };

const MARKER_FILE_NAME = "t3code-wsl-server-tree.json";
const COPY_CONCURRENCY = 8;

const Marker = Schema.Struct({ version: Schema.String });
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(Marker));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(Marker));

export class DesktopWslServerTreeExtractError extends Schema.TaggedError<DesktopWslServerTreeExtractError>()(
  "DesktopWslServerTreeExtractError",
  {
    targetDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to extract the WSL server tree to ${this.targetDir}.`;
  }
}

export class DesktopWslServerTree extends Context.Service<
  DesktopWslServerTree,
  {
    readonly ensure: Effect.Effect<WslServerTreeResult>;
    readonly cleanupLegacy: Effect.Effect<void>;
  }
>()("@t3tools/desktop/wsl/DesktopWslServerTree") {}

export const forEachBoundedTree = Effect.fn("DesktopWslServerTree.forEachBoundedTree")(function* <
  Node,
  E,
  R,
>(
  roots: ReadonlyArray<Node>,
  visit: (node: Node) => Effect.Effect<ReadonlyArray<Node>, E, R>,
): Effect.fn.Return<void, E, R> {
  const pending = [...roots];
  while (pending.length > 0) {
    const batch = pending.splice(-COPY_CONCURRENCY);
    const children = yield* Effect.forEach(batch, visit, {
      concurrency: COPY_CONCURRENCY,
    });
    for (const entries of children) {
      pending.push(...entries);
    }
  }
});

interface CopyTreeEntry {
  readonly sourcePath: string;
  readonly targetPath: string;
}

const copyTree = (
  fs: FileSystem.FileSystem,
  join: (first: string, ...rest: string[]) => string,
  from: string,
  to: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
  forEachBoundedTree<CopyTreeEntry, PlatformError.PlatformError, never>(
    [{ sourcePath: from, targetPath: to }],
    ({ sourcePath, targetPath }) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(sourcePath);
        if (info.type === "Directory") {
          yield* fs.makeDirectory(targetPath, { recursive: true });
          const entries = yield* fs.readDirectory(sourcePath);
          return entries.map((entry) => ({
            sourcePath: join(sourcePath, entry),
            targetPath: join(targetPath, entry),
          }));
        }
        if (info.type === "File") {
          const bytes = yield* fs.readFile(sourcePath);
          yield* fs.writeFile(targetPath, bytes);
        }
        return [];
      }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const join = environment.path.join;

  const serverRoot = environment.serverRoot;
  const needsExtraction = environment.isPackaged && environment.platform === "win32";
  const treeRoot = join(environment.stateDir, "wsl-server-tree");
  const version = environment.appVersion;
  const versionDir = join(treeRoot, version);

  const sweepStale = Effect.gen(function* () {
    const entries = yield* fs.readDirectory(treeRoot).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      entries.filter((entry) => entry !== version),
      (entry) => fs.remove(join(treeRoot, entry), { recursive: true }).pipe(Effect.ignore),
      { discard: true },
    );
  });

  const markerMatches = Effect.gen(function* () {
    const raw = yield* fs.readFileString(join(versionDir, MARKER_FILE_NAME));
    const marker = yield* decodeMarker(raw);
    return marker.version === version;
  }).pipe(Effect.orElseSucceed(() => false));

  const extract = Effect.gen(function* () {
    yield* Effect.log(`[wsl-server-tree] Extracting ${serverRoot} to ${versionDir}...`);
    yield* fs.makeDirectory(treeRoot, { recursive: true });
    // A sibling temp directory permits atomic rename; explicit cleanup avoids a scoped finalizer failing after the move.
    const partialDir = yield* fs.makeTempDirectory({
      directory: treeRoot,
      prefix: `.${version}.extract-`,
    });
    yield* Effect.gen(function* () {
      yield* copyTree(fs, join, serverRoot, partialDir);
      const markerJson = yield* encodeMarker({ version });
      yield* fs.writeFileString(join(partialDir, MARKER_FILE_NAME), `${markerJson}\n`);
      yield* fs.remove(versionDir, { recursive: true }).pipe(Effect.ignore);
      yield* fs.rename(partialDir, versionDir);
    }).pipe(
      Effect.ensuring(fs.remove(partialDir, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
    yield* Effect.log(`[wsl-server-tree] Extraction complete at ${versionDir}.`);
  }).pipe(
    Effect.mapError(
      (cause) => new DesktopWslServerTreeExtractError({ targetDir: versionDir, cause }),
    ),
  );

  const gate = yield* Semaphore.make(1);

  const cleanupLegacy = gate
    .withPermits(1)(
      needsExtraction
        ? Effect.gen(function* () {
            // Delete completeness first: a locked Windows file can leave a half-deleted tree that must not be reused.
            yield* fs.remove(join(versionDir, MARKER_FILE_NAME), { force: true });
            yield* fs.remove(treeRoot, { recursive: true, force: true });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("[wsl-server-tree] Could not remove the legacy extraction cache.", {
                treeRoot,
                cause,
              }),
            ),
          )
        : Effect.void,
    )
    .pipe(Effect.withSpan("desktop.wslServerTree.cleanupLegacy"));

  const ensure: Effect.Effect<WslServerTreeResult> = gate
    .withPermits(1)(
      Effect.gen(function* () {
        if (!needsExtraction) {
          return { ok: true, root: serverRoot } as const;
        }
        if (yield* markerMatches) {
          yield* sweepStale;
          return { ok: true, root: versionDir } as const;
        }
        const result = yield* extract.pipe(
          Effect.map(() => ({ ok: true, root: versionDir }) as const),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false,
              reason: `WSL server files could not be extracted to ${versionDir}: ${
                error.cause instanceof Error ? error.cause.message : String(error.cause)
              }`,
              fatal: false,
            } as const),
          ),
        );
        if (result.ok) {
          yield* sweepStale;
        }
        return result;
      }),
    )
    .pipe(Effect.withSpan("desktop.wslServerTree.ensure"));

  return DesktopWslServerTree.of({ ensure, cleanupLegacy });
});

export const layer = Layer.effect(DesktopWslServerTree, make);

export interface DesktopWslServerTreeTestStub {
  readonly result?: WslServerTreeResult;
  readonly cleanupLegacy?: Effect.Effect<void>;
}

export const layerTest = (stub: DesktopWslServerTreeTestStub = {}) =>
  Layer.effect(
    DesktopWslServerTree,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return DesktopWslServerTree.of({
        ensure: Effect.succeed(stub.result ?? { ok: true, root: environment.appRoot }),
        cleanupLegacy: stub.cleanupLegacy ?? Effect.void,
      });
    }),
  );
