import * as inspector from "node:inspector";
import * as NodeModule from "node:module";
import { pathToFileURL } from "node:url";
import type { transformSync } from "rolldown/utils";

export type SourceMap = NonNullable<ReturnType<typeof transformSync>["map"]>;

/**
 * The map as stored in the cache: `sources` names the file by URL and
 * `sourcesContent` is dropped. A bare path in `sources` is resolved against
 * the map's own location — the shared cache directory — whereas a URL is
 * location-independent and correct on Windows too. Every source is a file
 * on this machine, so embedding its text only makes the map larger than
 * the code it describes and every process that loads the module pay for it.
 */
export const storedSourceMap = (
  { sourcesContent: _sourcesContent, ...map }: SourceMap,
  filePath: string,
): string => JSON.stringify({ ...map, sources: [pathToFileURL(filePath).href] });

/** Where a module's source map is, and how to get its text if needed. */
export interface SourceMapRef {
  /** Absolute path of the map on disk, if it has been written there. */
  readonly file: string | undefined;
  readonly text: () => string;
}

/**
 * Whether a debugger can be attached to this process. Checked per module, so
 * an inspector opened after startup (VS Code auto-attach, `SIGUSR1`,
 * `inspector.open()`) covers every module loaded from then on.
 */
const isInspectorActive = () => inspector.url() !== undefined;

const inlineComment = (map: string) =>
  `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}`;

/**
 * Map by reference. Node's source-map support only understands `data:`
 * URLs and scheme-less paths (it resolves the latter against the module
 * URL and reads the file), so this is the file URL's path component —
 * `/var/…/x.map` on POSIX, `/C:/…/x.map` on Windows — never a `file:` URL.
 */
const fileComment = (mapFile: string) =>
  `\n//# sourceMappingURL=${pathToFileURL(mapFile).pathname}`;

/**
 * `code` with its source map attached.
 *
 * Normally by reference to the file on disk: an inline `data:` map is part
 * of the script source V8 keeps for the process lifetime, which for a graph
 * the size of alchemy's is hundreds of megabytes. Inlined when there is no
 * file, and — with the source embedded — while a debugger is attached: a
 * map in the shared cache directory is one debuggers either refuse to read
 * (VS Code only loads maps under the workspace by default) or cannot fetch
 * over the inspector protocol (DevTools), leaving every module to show up
 * as transpiled output from a foreign folder.
 */
export const attachSourceMap = (code: string, map: SourceMapRef, readSource: () => string) => {
  if (isInspectorActive()) {
    return (
      code +
      inlineComment(JSON.stringify({ ...JSON.parse(map.text()), sourcesContent: [readSource()] }))
    );
  }
  return code + (map.file === undefined ? inlineComment(map.text()) : fileComment(map.file));
};

const supportKey = Symbol.for("@alchemy.run/node-utils/source-map-support");

interface SourceMapSupportLease {
  holders: number;
  readonly previous: ReturnType<typeof NodeModule.getSourceMapsSupport>;
}

/**
 * Turns Node's source-map support on for as long as any holder of a lease
 * keeps it, and restores the previous setting once the last one releases
 * theirs. Transformed sources only reference their maps; Node reads and
 * applies them to stack traces when this is on. `nodeModules` stays on: a
 * published alchemy runs its own `lib/` from `node_modules`, and ships maps
 * back to its `src/`. Leases are counted on `globalThis` because a checkout
 * can load this module twice (src/ and lib/).
 */
export const leaseSourceMapSupport = (): (() => void) => {
  const leases = globalThis as typeof globalThis & { [supportKey]?: SourceMapSupportLease };
  let lease = leases[supportKey];
  if (lease === undefined) {
    const previous = NodeModule.getSourceMapsSupport();
    NodeModule.setSourceMapsSupport(true, {
      nodeModules: true,
      generatedCode: previous.generatedCode,
    });
    lease = leases[supportKey] = { holders: 0, previous };
  }
  lease.holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lease.holders > 0) return;
    delete leases[supportKey];
    const { enabled, ...options } = lease.previous;
    NodeModule.setSourceMapsSupport(enabled, options);
  };
};
