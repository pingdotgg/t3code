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
  readonly fps: number;
  /** Frames that missed at least one 60 Hz vsync. Headless Chrome presents at 60 Hz at most. */
  readonly missed60Hz: number;
}

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const round = (value: number) => Math.round(value * 10) / 10;

const BUDGET_60HZ_MS = 1000 / 60;
const BUDGET_120HZ_MS = 1000 / 120;

export function summarizeFrames(frames: ReadonlyArray<number>): FrameSummary {
  const sorted = frames.toSorted((a, b) => a - b);
  const totalMs = frames.reduce((sum, frame) => sum + frame, 0);
  return {
    frames: frames.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
    fps: totalMs === 0 ? 0 : round((frames.length * 1000) / totalMs),
    // Intervals land on whole vsyncs, so anything past one and a half is a missed one.
    missed60Hz: frames.filter((frame) => frame > BUDGET_60HZ_MS * 1.5).length,
  };
}

export interface TraceEvent {
  readonly ph: string;
  readonly name: string;
  readonly pid: number;
  readonly tid: number;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: { readonly name?: string };
}

export interface TaskSummary {
  readonly tasks: number;
  readonly longestMs: number;
  /** Tasks longer than a frame budget; each one blocks at least one frame at that rate. */
  readonly over60Hz: number;
  readonly over120Hz: number;
  /** Time past the budget summed over tasks, like Lighthouse's total blocking time. */
  readonly blockedMs60Hz: number;
  readonly blockedMs120Hz: number;
}

/**
 * Main-thread tasks of the page from a `toplevel` trace. A task over 8.3 ms blocks a 120 Hz
 * frame on any display, which frame intervals cannot show while headless Chrome caps at 60 Hz.
 */
export function summarizeTasks(events: ReadonlyArray<TraceEvent>): TaskSummary {
  const rendererMain = new Set(
    events
      .filter((event) => event.ph === "M" && event.name === "thread_name")
      .filter((event) => event.args?.name === "CrRendererMain")
      .map((event) => `${event.pid}:${event.tid}`),
  );
  const byThread = new Map<string, number[]>();
  for (const event of events) {
    const thread = `${event.pid}:${event.tid}`;
    if (event.ph !== "X" || event.name !== "ThreadControllerImpl::RunTask") continue;
    if (!rendererMain.has(thread)) continue;
    let durations = byThread.get(thread);
    if (!durations) byThread.set(thread, (durations = []));
    durations.push((event.dur ?? 0) / 1000);
  }
  // The app's renderer is the busy one; others (about:blank, spare renderers) barely run.
  const durations = [...byThread.values()].reduce<number[]>(
    (busiest, thread) =>
      thread.reduce((a, b) => a + b, 0) > busiest.reduce((a, b) => a + b, 0) ? thread : busiest,
    [],
  );
  const over = (budget: number) => durations.filter((ms) => ms > budget);
  const blocked = (budget: number) =>
    Math.round(over(budget).reduce((sum, ms) => sum + ms - budget, 0));
  return {
    tasks: durations.length,
    longestMs: round(durations.reduce((longest, ms) => Math.max(longest, ms), 0)),
    over60Hz: over(BUDGET_60HZ_MS).length,
    over120Hz: over(BUDGET_120HZ_MS).length,
    blockedMs60Hz: blocked(BUDGET_60HZ_MS),
    blockedMs120Hz: blocked(BUDGET_120HZ_MS),
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
