// @effect-diagnostics nodeBuiltinImport:off - a standalone report builder for the stress rig.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface CpuProfile {
  readonly nodes: ReadonlyArray<{
    readonly id: number;
    readonly callFrame: {
      readonly functionName: string;
      readonly url: string;
      readonly lineNumber: number;
    };
    readonly children?: ReadonlyArray<number>;
  }>;
  readonly samples: ReadonlyArray<number>;
  readonly timeDeltas: ReadonlyArray<number>;
}

export interface FrameSummary {
  readonly frames: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Frames that took longer than two 60 Hz intervals, so at least one frame was dropped. */
  readonly droppedFrames: number;
}

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const round = (value: number) => Math.round(value * 10) / 10;

export function summarizeFrames(frames: ReadonlyArray<number>): FrameSummary {
  const sorted = frames.toSorted((a, b) => a - b);
  return {
    frames: frames.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
    droppedFrames: frames.filter((frame) => frame > 1000 / 30).length,
  };
}

/** Total long-animation-frame script time by script, worst first. */
export function longFrameScripts(
  longFrames: ReadonlyArray<{
    readonly scripts: ReadonlyArray<{ readonly source: string; readonly duration: number }>;
  }>,
  top = 15,
): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const frame of longFrames) {
    for (const script of frame.scripts) {
      totals.set(script.source, (totals.get(script.source) ?? 0) + script.duration);
    }
  }
  return [...totals]
    .map(([source, ms]): [string, number] => [source, Math.round(ms)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
}

/** Maps each bundle line to the source module above it, from Rolldown's `// path` comments. */
function moduleOwners(assetsDir: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const file of NodeFS.readdirSync(assetsDir).filter((name) => name.endsWith(".js"))) {
    let current = "(bundle)";
    owners.set(
      file,
      NodeFS.readFileSync(NodePath.join(assetsDir, file), "utf8")
        .split("\n")
        .map((line) => {
          const path = /^\/\/ (\S+\.(?:js|mjs|cjs|ts|tsx))$/.exec(line)?.[1];
          if (path) {
            const pkg = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
              path,
            )?.[1];
            current = pkg ?? path.replace(/^(?:\.\.\/)+/, "");
          }
          return current;
        }),
    );
  }
  return owners;
}

/**
 * Self time by function and by source module or package, idle excluded. Samples with no page
 * script on the stack are the rig's own work (Playwright's injected selectors) or the browser's,
 * so they are counted apart and left out of the rankings.
 */
export function summarizeProfile(profile: CpuProfile, assetsDir: string, top = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const fromPage = new Map<number, boolean>();
  const isFromPage = (id: number): boolean => {
    const known = fromPage.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const parentId = parent.get(id);
    const result =
      node !== undefined &&
      (/^https?:/.test(node.callFrame.url) || (parentId !== undefined && isFromPage(parentId)));
    fromPage.set(id, result);
    return result;
  };
  const owners = moduleOwners(assetsDir);
  const byFunction = new Map<string, number>();
  const byModule = new Map<string, number>();
  let busyUs = 0;
  let outsidePageUs = 0;
  profile.samples.forEach((id, index) => {
    const node = byId.get(id);
    const delta = profile.timeDeltas[index + 1] ?? 0;
    if (!node || ["(idle)", "(program)"].includes(node.callFrame.functionName)) return;
    busyUs += delta;
    const garbage = node.callFrame.functionName === "(garbage collector)";
    if (!garbage && !isFromPage(id)) {
      outsidePageUs += delta;
      return;
    }
    const file = node.callFrame.url.split("/").pop() ?? "";
    const fn = `${node.callFrame.functionName || "(anonymous)"} ${file}:${node.callFrame.lineNumber + 1}`;
    byFunction.set(fn, (byFunction.get(fn) ?? 0) + delta);
    const owner =
      owners.get(file)?.[node.callFrame.lineNumber] ?? (file || node.callFrame.functionName);
    byModule.set(owner, (byModule.get(owner) ?? 0) + delta);
  });
  const ranked = (map: Map<string, number>) =>
    [...map]
      .map(([name, us]): [string, number] => [name, Math.round(us / 1000)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, top);
  return {
    busyMs: Math.round(busyUs / 1000),
    outsidePageMs: Math.round(outsidePageUs / 1000),
    byFunction: ranked(byFunction),
    byModule: ranked(byModule),
  };
}
