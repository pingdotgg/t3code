// @effect-diagnostics nodeBuiltinImport:off - Standalone Node performance probe.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

import * as Effect from "effect/Effect";

import * as WorkspaceSearchIndex from "../src/workspace/WorkspaceSearchIndex.ts";

const DEFAULT_LIMITS = [1_000, 5_000, 25_000];
const CHILD_FLAG = "--child";

interface MemorySample {
  readonly maxEntries: number;
  readonly returnedEntries: number;
  readonly truncated: boolean;
  readonly indexedRssMiB: number;
  readonly listedRssMiB: number;
  readonly listDeltaRssMiB: number;
  readonly indexedPeakRssMiB: number;
  readonly listedPeakRssMiB: number;
  readonly listPeakDeltaRssMiB: number;
}

function memorySample(): { readonly rssMiB: number; readonly peakRssMiB: number } {
  globalThis.gc?.();
  return {
    rssMiB: Math.round((NodeProcess.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    peakRssMiB: Math.round((NodeProcess.resourceUsage().maxRSS / 1024) * 10) / 10,
  };
}

function parsePositiveInteger(input: string, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, received '${input}'.`);
  }
  return value;
}

async function measure(cwd: string, maxEntries: number): Promise<MemorySample> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const index = yield* WorkspaceSearchIndex.make(cwd, "paths", {
          maxListEntries: maxEntries,
        });
        const indexed = memorySample();
        const result = yield* index.list();
        const listed = memorySample();

        return {
          maxEntries,
          returnedEntries: result.entries.length,
          truncated: result.truncated,
          indexedRssMiB: indexed.rssMiB,
          listedRssMiB: listed.rssMiB,
          listDeltaRssMiB: Math.round((listed.rssMiB - indexed.rssMiB) * 10) / 10,
          indexedPeakRssMiB: indexed.peakRssMiB,
          listedPeakRssMiB: listed.peakRssMiB,
          listPeakDeltaRssMiB: Math.round((listed.peakRssMiB - indexed.peakRssMiB) * 10) / 10,
        };
      }),
    ),
  );
}

function runChild(cwd: string, maxEntries: number): MemorySample {
  if (NodeProcess.release.name !== "node") {
    throw new Error("Run the workspace memory probe with Node.js.");
  }
  const execArgs = NodeProcess.execArgv.includes("--expose-gc")
    ? NodeProcess.execArgv
    : [...NodeProcess.execArgv, "--expose-gc"];
  const child = NodeChildProcess.spawnSync(
    NodeProcess.execPath,
    [...execArgs, import.meta.filename, CHILD_FLAG, cwd, String(maxEntries)],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (child.error) {
    throw new Error("Unable to start the workspace memory probe child process.", {
      cause: child.error,
    });
  }
  if (child.status !== 0) {
    const detail = child.stderr?.trim();
    throw new Error(
      detail ||
        `Memory probe exited with status ${String(child.status)} and signal ${String(child.signal)}.`,
    );
  }
  try {
    return JSON.parse(child.stdout) as MemorySample;
  } catch (cause) {
    throw new Error("Workspace memory probe child returned invalid JSON.", { cause });
  }
}

const args = NodeProcess.argv.slice(2);
if (args[0] === CHILD_FLAG) {
  const cwd = args[1];
  const maxEntriesText = args[2];
  if (!cwd || !maxEntriesText) {
    throw new Error("Child probe requires a cwd and maximum entry count.");
  }
  NodeProcess.stdout.write(
    JSON.stringify(await measure(cwd, parsePositiveInteger(maxEntriesText, "maxEntries"))),
  );
} else {
  const cwd = args[0] ?? NodeProcess.cwd();
  const limits =
    args.length > 1
      ? args.slice(1).map((input) => parsePositiveInteger(input, "maxEntries"))
      : DEFAULT_LIMITS;
  const samples = limits.map((limit) => runChild(cwd, limit));

  NodeProcess.stdout.write(`Workspace: ${cwd}\n`);
  console.table(samples);
}
