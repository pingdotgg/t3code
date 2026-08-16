import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

// Packaged Windows builds ship the server tree inside resources/server.asar
// (see scripts/build-desktop-artifact.ts). The Windows primary reads it in
// place through the asar-aware ELECTRON_RUN_AS_NODE runtime, but the WSL
// backend launches plain `wsl.exe -- node`, which cannot read an asar
// archive. This service materializes the archive into a real, version-keyed
// directory the first time the WSL backend starts, and reuses it afterwards —
// so only users who enable WSL ever pay for a loose copy of the server tree.
//
// Reading through Electron's patched fs also transparently returns the
// contents of files that electron-builder/asar left in the server.asar.unpacked
// sibling (native binaries), so a single walk of the archive yields the
// complete tree.

export type WslServerTreeResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: string; readonly fatal: boolean };

const MARKER_FILE_NAME = "t3code-wsl-server-tree.json";
const COPY_CONCURRENCY = 8;

const Marker = Schema.Struct({ version: Schema.String });
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(Marker));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(Marker));

export class DesktopWslServerTreeExtractError extends Schema.TaggedErrorClass<DesktopWslServerTreeExtractError>()(
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
    // Resolves the directory the WSL backend should treat as the app root
    // (the directory containing apps/server/dist and node_modules). In dev
    // the checkout already is that directory; packaged Windows builds extract
    // server.asar on first use.
    readonly ensure: Effect.Effect<WslServerTreeResult>;
  }
>()("@t3tools/desktop/wsl/DesktopWslServerTree") {}

// Child scheduling stays here instead of inside `visit`, so nested directories
// cannot create independent concurrency pools. The LIFO work list also keeps
// traversal memory proportional to the remaining frontier rather than the
// number of active fibers.
export const forEachBoundedTree = <Node, E, R>(
  roots: ReadonlyArray<Node>,
  visit: (node: Node) => Effect.Effect<ReadonlyArray<Node>, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
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

// Copy using only operations supported by Electron's asar-patched fs. Symlinks
// are not expected because the sidecar is installed with a hoisted, physical
// layout; anything that is neither a file nor a directory is skipped.
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
          // Read and write stay in the same bounded task, so at most eight file
          // buffers can be retained while their writes complete.
          const bytes = yield* fs.readFile(sourcePath);
          yield* fs.writeFile(targetPath, bytes);
        }
        return [];
      }),
  );

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const join = environment.path.join;

  const serverRoot = environment.serverRoot;
  const needsExtraction = environment.isPackaged && environment.platform === "win32";
  const treeRoot = join(environment.stateDir, "wsl-server-tree");
  const version = environment.appVersion;
  const versionDir = join(treeRoot, version);

  // Remove sibling trees left behind by previous app versions (and aborted
  // extractions). Best-effort: a locked file must not block the backend.
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
    // Keep the temporary tree beside the target so rename is atomic. Cleanup
    // is owned explicitly because a scoped temp-directory finalizer treats the
    // successful rename (and therefore missing original path) as an error.
    const partialDir = yield* fs.makeTempDirectory({
      directory: treeRoot,
      prefix: `.${version}.extract-`,
    });
    yield* Effect.gen(function* () {
      yield* copyTree(fs, join, serverRoot, partialDir);
      const markerJson = yield* encodeMarker({ version });
      yield* fs.writeFileString(join(partialDir, MARKER_FILE_NAME), `${markerJson}\n`);
      // The marker is written before the rename, so a directory named after
      // the version is complete by construction.
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

  // Serialize concurrent ensure calls (backend restarts can overlap): the
  // first caller extracts, later callers see the marker and reuse the tree.
  const gate = yield* Semaphore.make(1);

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
          // Retryable: transient antivirus locks and slow disks are the common
          // causes, and the backend manager already bounds preflight retries.
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

  return DesktopWslServerTree.of({ ensure });
});

export const layer = Layer.effect(DesktopWslServerTree, make);

export interface DesktopWslServerTreeTestStub {
  readonly result?: WslServerTreeResult;
}

export const layerTest = (stub: DesktopWslServerTreeTestStub = {}) =>
  Layer.effect(
    DesktopWslServerTree,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      return DesktopWslServerTree.of({
        ensure: Effect.succeed(stub.result ?? { ok: true, root: environment.appRoot }),
      });
    }),
  );
