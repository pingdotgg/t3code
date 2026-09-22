import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Dependency-graph guards for the mobile source tree (audit #13).
 *
 * 1. No circular imports, checked once per platform the way Metro resolves
 *    modules (`<name>.<platform>.*` before `<name>.native.*` before the
 *    generic file). A cycle can hide behind platform resolution: a `.tsx`
 *    base importing a component whose `.android.tsx` variant type-imports
 *    back into the base is acyclic on iOS but circular on Android.
 *    Dynamic `import("...")` calls are excluded from this rule on purpose:
 *    they are the deliberate async escape hatch (e.g. composer-draft cleanup
 *    reaching `lib/attachmentUpload`), and Metro resolves them after both
 *    modules have initialized, so they cannot create an initialization cycle.
 *
 * 2. Cross-layer edges are ceilinged, not yet banned. `state`, `lib`,
 *    `native`, and `components` still reach upward into `features` at known
 *    sites (the app composition root `lib/runtime.ts` legitimately wires
 *    feature layers). Ceilings count unique `from -> to` module pairs across
 *    all platforms, including dynamic imports, and may only shrink: when you
 *    remove one of these imports, lower the constant in the same PR.
 */

const SOURCE_ROOT = __dirname;

/** Metro candidate order per platform (platform, then native, then generic). */
const PLATFORM_EXTENSION_ORDER = {
  android: [".android.ts", ".android.tsx", ".native.ts", ".native.tsx", ".ts", ".tsx"],
  ios: [".ios.ts", ".ios.tsx", ".native.ts", ".native.tsx", ".ts", ".tsx"],
} as const;

type Platform = keyof typeof PLATFORM_EXTENSION_ORDER;

const PLATFORMS = Object.keys(PLATFORM_EXTENSION_ORDER) as ReadonlyArray<Platform>;

const isGraphFile = (filePath: string): boolean =>
  /\.tsx?$/.test(filePath) &&
  !filePath.includes(".test.") &&
  !filePath.includes("test-support") &&
  !filePath.endsWith(".d.ts");

/** Files Metro would not even bundle for the other platform. */
function isRelevantForPlatform(filePath: string, platform: Platform): boolean {
  const name = NodePath.basename(filePath);
  if (platform === "android") {
    return !name.includes(".ios.");
  }
  return !name.includes(".android.");
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(dir)) {
    const filePath = NodePath.join(dir, entry);
    if (NodeFS.statSync(filePath).isDirectory()) {
      collectSourceFiles(filePath, out);
    } else if (isGraphFile(filePath)) {
      out.push(filePath);
    }
  }
  return out;
}

function resolveRelative(
  fromFile: string,
  specifier: string,
  extensionOrder: ReadonlyArray<string>,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = NodePath.resolve(NodePath.dirname(fromFile), specifier);
  for (const ext of extensionOrder) {
    for (const candidate of [base + ext, NodePath.join(base, `index${ext}`)]) {
      try {
        if (NodeFS.statSync(candidate).isFile()) {
          const resolved = NodePath.resolve(candidate);
          return resolved.startsWith(SOURCE_ROOT + NodePath.sep) ? resolved : null;
        }
      } catch {
        // Candidate does not exist; try the next one.
      }
    }
  }
  return null;
}

interface ParsedImport {
  readonly specifier: string;
  readonly isDynamic: boolean;
}

function parseImports(source: string): ParsedImport[] {
  const parsed: ParsedImport[] = [];
  const staticRe = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  const bareRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticRe)) {
    parsed.push({ specifier: match[1]!, isDynamic: false });
  }
  for (const match of source.matchAll(bareRe)) {
    parsed.push({ specifier: match[1]!, isDynamic: false });
  }
  for (const match of source.matchAll(dynamicRe)) {
    parsed.push({ specifier: match[1]!, isDynamic: true });
  }
  return parsed;
}

type Layer = "state" | "lib" | "components" | "native" | "features" | "other";

function layerOf(relativePath: string): Layer {
  const top = relativePath.split(NodePath.sep)[0]!;
  if (top === "features") return "features";
  return top === "state" || top === "lib" || top === "components" || top === "native"
    ? (top as Layer)
    : "other";
}

interface PlatformGraph {
  readonly platform: Platform;
  readonly files: ReadonlyArray<string>;
  /** Static (type or value) import edges keyed by source file. */
  readonly staticEdges: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Unique cross-layer edges, static and dynamic, as "fromRel -> toRel". */
  readonly crossLayerEdges: ReadonlySet<string>;
}

function buildPlatformGraph(platform: Platform): PlatformGraph {
  const extensionOrder = PLATFORM_EXTENSION_ORDER[platform];
  const files = collectSourceFiles(SOURCE_ROOT)
    .filter((file) => isRelevantForPlatform(file, platform))
    .sort();
  const staticEdges = new Map<string, string[]>();
  const crossLayerEdges = new Set<string>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const { specifier, isDynamic } of parseImports(NodeFS.readFileSync(file, "utf8"))) {
      const resolved = resolveRelative(file, specifier, extensionOrder);
      if (resolved === null || resolved === file) {
        continue;
      }
      const from = NodePath.relative(SOURCE_ROOT, file);
      const to = NodePath.relative(SOURCE_ROOT, resolved);
      const fromLayer = layerOf(from);
      const toLayer = layerOf(to);
      const upward =
        (fromLayer === "state" ||
          fromLayer === "lib" ||
          fromLayer === "components" ||
          fromLayer === "native") &&
        (toLayer === "features" || (fromLayer === "lib" && toLayer === "state"));
      if (upward) {
        crossLayerEdges.add(`${from} -> ${to}`);
      }
      if (!isDynamic) {
        targets.add(resolved);
      }
    }
    staticEdges.set(file, [...targets]);
  }
  return { platform, files, staticEdges, crossLayerEdges };
}

/** Tarjan strongly-connected components, iterative to bound stack depth. */
function findCycles(graph: PlatformGraph): ReadonlyArray<ReadonlyArray<string>> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let nextIndex = 0;

  const enter = (node: string): void => {
    index.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
  };

  for (const root of graph.files) {
    if (index.has(root)) continue;
    const work: Array<[string, number]> = [[root, 0]];
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbors = graph.staticEdges.get(frame[0]) ?? [];
      let advanced = false;
      for (let i = frame[1]; i < neighbors.length; i += 1) {
        const child = neighbors[i]!;
        if (!graph.staticEdges.has(child)) continue;
        if (!index.has(child)) {
          work[work.length - 1] = [frame[0], i + 1];
          work.push([child, 0]);
          enter(child);
          advanced = true;
          break;
        } else if (onStack.has(child)) {
          low.set(frame[0], Math.min(low.get(frame[0])!, index.get(child)!));
        }
      }
      if (advanced) continue;
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent[0], Math.min(low.get(parent[0])!, low.get(frame[0])!));
      }
      if (low.get(frame[0]) === index.get(frame[0])) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame[0]);
        if (component.length > 1) {
          cycles.push(component.sort().map((file) => NodePath.relative(SOURCE_ROOT, file)));
        }
      }
    }
  }
  return cycles;
}

const graphs = PLATFORMS.map(buildPlatformGraph);

/** Unique upward edge pairs across every platform, sorted for stable diffs. */
function upwardEdges(): string[] {
  const union = new Set<string>();
  for (const graph of graphs) {
    for (const edge of graph.crossLayerEdges) {
      union.add(edge);
    }
  }
  return [...union].sort();
}

describe("mobile dependency graph", () => {
  it.each(PLATFORMS)("has no circular imports under %s resolution", (platform) => {
    const graph = graphs.find((candidate) => candidate.platform === platform)!;
    // The graph must see real files; a resolution regression here would make
    // both rules vacuously pass.
    expect(graph.files.length).toBeGreaterThan(500);
    expect(findCycles(graph)).toEqual([]);
  });

  it("keeps upward imports from state/lib/components/native into features at the ceiling", () => {
    const edges = upwardEdges();
    const edgesFor = (from: Layer, to: Layer): string[] =>
      edges.filter((edge) => {
        const [source, target] = edge.split(" -> ");
        return layerOf(source!) === from && layerOf(target!) === to;
      });

    const ceilings: ReadonlyArray<readonly [Layer, Layer, number, string]> = [
      // state -> features: thread ordering reaching the thread-list model,
      // the incoming-share store, the connection controller hook, the
      // terminal launch context, and the pending message feed.
      // (legacy-plan-mode was pure model logic and moved into state/.)
      ["state", "features", 6, "state must not add imports from features"],
      // lib -> features: lib/runtime.ts is the app composition root and
      // legitimately wires cloud/observability features; the appearance
      // helpers and terminal preferences still need untangling.
      ["lib", "features", 7, "lib must not add imports from features"],
      // components -> features: mostly the appearance preferences provider
      // and the layout toolbar bridges.
      ["components", "features", 33, "components must not add imports from features"],
      // native -> features: native glue reading appearance/keyboard/review features.
      ["native", "features", 8, "native must not add imports from features"],
      // lib -> state: attachment/session plumbing that predates the cycle
      // cleanup; each remaining edge needs a real owner-side seam.
      ["lib", "state", 11, "lib must not add imports from state"],
    ];

    for (const [from, to, ceiling, message] of ceilings) {
      const layerEdges = edgesFor(from, to);
      expect(
        layerEdges.length,
        `${message}. ${layerEdges.length} edges remain:\n${layerEdges.join("\n")}`,
      ).toBeLessThanOrEqual(ceiling);
    }
  });
});
