import type { ResourceTelemetryProcess } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

import * as ServerConfig from "../config.ts";
import { metricAttributes } from "../observability/Metrics.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

const SAMPLE_INTERVAL = "1 minute";

const residentBytes = Metric.gauge("t3_process_group_resident_bytes", {
  description: "Resident memory of the server's processes, summed by group.",
  attributes: { unit: "By" },
});
const cpuPercent = Metric.gauge("t3_process_group_cpu_percent", {
  description: "CPU use of the server's processes, summed by group; 100 is one full core.",
  attributes: { unit: "%" },
});
const processCount = Metric.gauge("t3_process_group_count", {
  description: "Processes in each group.",
  attributes: { unit: "{process}" },
});

// Each direct child of the server names the group of its whole subtree. A fixed set keeps one
// series per group per server, however many agents and processes come and go.
const PROVIDER_GROUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/codex/, "codex"],
  [/claude/, "claude"],
  [/cursor/, "cursor"],
  [/opencode/, "opencode"],
  [/grok/, "grok"],
  [/antigravity|gemini/, "antigravity"],
];
const OTHER_GROUPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/chrom/, "browser"],
  [/^(?:ba|z|fi|da|c)?sh(?:\.exe)?$|^pwsh|^powershell|^cmd\.exe$/, "terminal"],
];
// A CLI shipped as a script runs under a JavaScript runtime, so its process name is the
// runtime's (older Claude packages run `node .../@anthropic-ai/claude-code/cli.js`). Only those
// are matched by command line; any other name is matched by name alone, so a shell or `git`
// whose arguments mention a provider stays in its own group.
const SCRIPT_RUNTIME = /^(?:node|bun|deno)(?:\.exe)?$/;

const match = (groups: ReadonlyArray<readonly [RegExp, string]>, text: string) =>
  groups.find(([pattern]) => pattern.test(text))?.[1];

const childGroup = (name: string, command: string) => {
  const lowerName = name.toLowerCase();
  if (SCRIPT_RUNTIME.test(lowerName))
    return match(PROVIDER_GROUPS, command.toLowerCase()) ?? "other";
  return match(PROVIDER_GROUPS, lowerName) ?? match(OTHER_GROUPS, lowerName) ?? "other";
};

export interface ProcessGroupTotals {
  readonly residentBytes: number;
  readonly cpuPercent: number;
  readonly count: number;
}

export function groupProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ReadonlyMap<string, ProcessGroupTotals> {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const serverPid = processes.find((process) => process.category === "server")?.identity.pid;
  const groupOf = (process: ResourceTelemetryProcess): string => {
    if (process.category === "server") return "server";
    if (process.category === "resource-monitor") return "resource-monitor";
    if (process.category.startsWith("electron-")) return "electron";
    let current = process;
    // Bounded by the table size, in case a reused PID makes the parent chain loop.
    for (let step = 0; step < processes.length; step++) {
      if (current.ppid === serverPid) return childGroup(current.name, current.command);
      const parent = byPid.get(current.ppid);
      if (parent === undefined) break;
      current = parent;
    }
    return "other";
  };
  const totals = new Map<string, ProcessGroupTotals>();
  for (const process of processes) {
    const group = groupOf(process);
    const total = totals.get(group) ?? { residentBytes: 0, cpuPercent: 0, count: 0 };
    totals.set(group, {
      residentBytes: total.residentBytes + process.residentBytes,
      cpuPercent: total.cpuPercent + process.cpuPercent,
      count: total.count + 1,
    });
  }
  return totals;
}

/**
 * Exports process totals by group while OTLP metrics export is on. Sampling walks the process
 * table, which an idle server otherwise never does, so only a server exporting metrics pays for
 * it, once a minute.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.otlpMetricsUrl === undefined) return;
    const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
    // A group that empties reads zero rather than holding its last value.
    const seen = new Set<string>();
    const sample = Effect.fn("ProcessGroupMetrics.sample")(function* () {
      const totals = groupProcesses((yield* telemetry.refresh).processes);
      for (const group of totals.keys()) seen.add(group);
      for (const group of seen) {
        const total = totals.get(group) ?? { residentBytes: 0, cpuPercent: 0, count: 0 };
        const attributes = metricAttributes({ group });
        yield* Metric.update(Metric.withAttributes(residentBytes, attributes), total.residentBytes);
        yield* Metric.update(Metric.withAttributes(cpuPercent, attributes), total.cpuPercent);
        yield* Metric.update(Metric.withAttributes(processCount, attributes), total.count);
      }
    });
    yield* sample().pipe(
      Effect.catch((error) =>
        Effect.logDebug("process group metrics sample failed", { error: error.message }),
      ),
      Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
