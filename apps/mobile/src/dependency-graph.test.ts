import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** Dynamic imports cannot create Metro initialization cycles: they resolve after both modules initialize. */

const SOURCE_ROOT = __dirname;

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
      } catch {}
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
  readonly staticEdges: ReadonlyMap<string, ReadonlyArray<string>>;
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

describe("mobile dependency graph", () => {
  it.each(PLATFORMS)("has no circular imports under %s resolution", (platform) => {
    const graph = graphs.find((candidate) => candidate.platform === platform)!;
    expect(graph.files.length).toBeGreaterThan(500);
    expect(findCycles(graph)).toEqual([]);
  });
});
