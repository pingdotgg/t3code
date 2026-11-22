import type {
  ElectronicsCircuitModel,
  ElectronicsSimulationKind,
  ElectronicsSimulationResult,
  ElectronicsToolBinaryStatus,
  ElectronicsValidationIssue,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const PROBE_TIMEOUT = Duration.seconds(5);
const RUN_TIMEOUT = Duration.seconds(20);

/**
 * Executes a single command without a shell and returns captured stdout, or fails cleanly on timeout/error.
 */
const execToolString = Effect.fn("ElectronicsToolchain.execToolString")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Duration,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(executable, [...args], {
    stdin: "ignore",
    stderr: "ignore",
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return yield* spawner.string(command).pipe(Effect.timeout(timeout));
});

export const probeBinary = Effect.fn("ElectronicsToolchain.probeBinary")(function* (
  name: "kicad-cli" | "ngspice",
  overridePath?: string,
): Effect.fn.Return<ElectronicsToolBinaryStatus, never, ChildProcessSpawner.ChildProcessSpawner> {
  const executable = overridePath && overridePath.trim().length > 0 ? overridePath.trim() : name;
  const args = name === "kicad-cli" ? ["--version"] : ["-v"];
  const output = yield* execToolString(executable, args, PROBE_TIMEOUT).pipe(
    Effect.map((raw) => ({ ok: true as const, raw })),
    Effect.catch((err) => Effect.succeed({ ok: false as const, err: String(err) })),
  );
  if (!output.ok) {
    return {
      name,
      available: false,
      ...(overridePath && overridePath.trim().length > 0 ? { path: executable } : {}),
      error: output.err.slice(0, 200),
    };
  }
  const firstLine = output.raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return {
    name,
    available: true,
    path: executable,
    ...(firstLine !== undefined ? { version: firstLine.slice(0, 120) } : {}),
  };
});

interface KiCadViolationRaw {
  readonly type?: string;
  readonly severity?: string;
  readonly description?: string;
  readonly items?: ReadonlyArray<{
    readonly description?: string;
    readonly pos?: { readonly x?: number; readonly y?: number };
  }>;
}

function mapKiCadSeverity(raw: string | undefined): "error" | "warning" | "info" {
  const lower = (raw ?? "").toLowerCase();
  if (lower === "error") return "error";
  if (lower === "warning") return "warning";
  return "info";
}

function parseKiCadJsonViolations(
  jsonText: string,
  source: "kicad_erc" | "kicad_drc",
): ElectronicsValidationIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const violations: KiCadViolationRaw[] = [];
  const obj = parsed as {
    violations?: KiCadViolationRaw[];
    unconnected_items?: KiCadViolationRaw[];
    sheets?: Array<{ violations?: KiCadViolationRaw[] }>;
  };

  if (Array.isArray(obj.violations)) violations.push(...obj.violations);
  if (Array.isArray(obj.unconnected_items)) violations.push(...obj.unconnected_items);
  if (Array.isArray(obj.sheets)) {
    for (const sheet of obj.sheets) {
      if (Array.isArray(sheet.violations)) violations.push(...sheet.violations);
    }
  }

  return violations.map((v, idx) => {
    const pos = v.items?.[0]?.pos;
    const detail = v.items
      ?.map((i) => i.description)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .slice(0, 2)
      .join("; ");
    const baseMsg = v.description ?? v.type ?? "KiCad rule violation";
    return {
      id: `${source}-${idx + 1}`,
      code: v.type ?? source,
      severity: mapKiCadSeverity(v.severity),
      source,
      message: detail ? `${baseMsg} (${detail})` : baseMsg,
      refs: [],
      ...(typeof pos?.x === "number" ? { x: pos.x } : {}),
      ...(typeof pos?.y === "number" ? { y: pos.y } : {}),
    };
  });
}

export const runKiCadExternalValidation = Effect.fn(
  "ElectronicsToolchain.runKiCadExternalValidation",
)(function* (input: {
  readonly absolutePath: string;
  readonly format: "kicad_sch" | "kicad_pcb";
  readonly kicadCliPath?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executable =
    input.kicadCliPath && input.kicadCliPath.trim().length > 0
      ? input.kicadCliPath.trim()
      : "kicad-cli";
  const source = input.format === "kicad_sch" ? ("kicad_erc" as const) : ("kicad_drc" as const);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kicad-" });
      const reportPath = path.join(tmpDir, "report.json");
      const args =
        input.format === "kicad_sch"
          ? ["sch", "erc", "--format", "json", "--output", reportPath, input.absolutePath]
          : ["pcb", "drc", "--format", "json", "--output", reportPath, input.absolutePath];

      // kicad-cli may exit non-zero when violations exist even though report.json was written.
      yield* execToolString(executable, args, RUN_TIMEOUT).pipe(Effect.ignore);
      const exists = yield* fs.exists(reportPath);
      if (!exists) {
        return {
          ran: false,
          source,
          issues: [] as ElectronicsValidationIssue[],
          note: `kicad-cli did not produce a JSON ${source === "kicad_erc" ? "ERC" : "DRC"} report.`,
        };
      }
      const reportText = yield* fs.readFileString(reportPath);
      const issues = parseKiCadJsonViolations(reportText, source);
      return {
        ran: true,
        source,
        issues,
        note: undefined as string | undefined,
      };
    }),
  ).pipe(
    Effect.catch((err) =>
      Effect.succeed({
        ran: false,
        source,
        issues: [] as ElectronicsValidationIssue[],
        note: `kicad-cli check failed: ${String(err).slice(0, 180)}`,
      }),
    ),
  );
});

export const runNgspiceSimulation = Effect.fn("ElectronicsToolchain.runNgspiceSimulation")(
  function* (input: {
    readonly model: ElectronicsCircuitModel;
    readonly spiceSource: string;
    readonly kind: ElectronicsSimulationKind;
    readonly ngspicePath?: string;
    readonly outputNode?: string;
    readonly startFreqHz?: number;
    readonly stopFreqHz?: number;
    readonly pointsPerDecade?: number;
    readonly stopTimeSeconds?: number;
    readonly stepTimeSeconds?: number;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executable =
      input.ngspicePath && input.ngspicePath.trim().length > 0
        ? input.ngspicePath.trim()
        : "ngspice";

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ngspice-" });
        const deckPath = path.join(tmpDir, "deck.cir");
        const stripped = input.spiceSource
          .split(/\r?\n/u)
          .filter((line) => !/^\s*\.(end|op|ac|tran|dc|control|endc)\b/iu.test(line))
          .join("\n");

        const targetNode =
          input.outputNode ?? input.model.nets.find((n) => !n.isGround)?.name ?? "out";

        const directive =
          input.kind === "dc_op"
            ? ".op\n.print op all"
            : input.kind === "ac_sweep"
              ? `.ac dec ${input.pointsPerDecade ?? 10} ${input.startFreqHz ?? 10} ${input.stopFreqHz ?? 1_000_000}\n.print ac vdb(${targetNode}) vp(${targetNode})`
              : `.tran ${input.stepTimeSeconds ?? 5e-5} ${input.stopTimeSeconds ?? 5e-3}\n.print tran v(${targetNode})`;

        const deck = `${stripped}\n${directive}\n.end\n`;
        yield* fs.writeFileString(deckPath, deck);

        const stdout = yield* execToolString(executable, ["-b", deckPath], RUN_TIMEOUT);
        const nodeVoltages: Array<{ node: string; voltageV: number }> = [];
        const points: Array<{ x: number; y: number; phaseDeg?: number }> = [];

        for (const line of stdout.split(/\r?\n/u)) {
          const opMatch = /^\s*([A-Za-z0-9_]+)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/iu.exec(
            line,
          );
          if (input.kind === "dc_op" && opMatch) {
            const node = opMatch[1]!;
            const val = Number(opMatch[2]!);
            if (Number.isFinite(val) && node.toLowerCase() !== "index") {
              nodeVoltages.push({ node, voltageV: Number(val.toPrecision(6)) });
            }
          }
          const tableMatch =
            /^\s*\d+\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?))?/iu.exec(
              line,
            );
          if (input.kind !== "dc_op" && tableMatch) {
            const xVal = Number(tableMatch[1]!);
            const yVal = Number(tableMatch[2]!);
            const third = tableMatch[3] !== undefined ? Number(tableMatch[3]) : undefined;
            if (Number.isFinite(xVal) && Number.isFinite(yVal)) {
              points.push({
                x: input.kind === "transient" ? Number((xVal * 1000).toPrecision(5)) : xVal,
                y: Number(yVal.toPrecision(5)),
                ...(third !== undefined && Number.isFinite(third)
                  ? { phaseDeg: Number(third.toFixed(2)) }
                  : {}),
              });
            }
          }
        }

        if (nodeVoltages.length === 0 && points.length === 0) {
          return null as ElectronicsSimulationResult | null;
        }

        return {
          filePath: input.model.filePath,
          kind: input.kind,
          engine: "ngspice" as const,
          xAxisLabel:
            input.kind === "ac_sweep" ? "Frequency" : input.kind === "transient" ? "Time" : "Node",
          xAxisUnit: input.kind === "ac_sweep" ? "Hz" : input.kind === "transient" ? "ms" : "",
          xAxisLog: input.kind === "ac_sweep",
          nodeVoltages,
          componentReadings: [],
          series:
            points.length > 0
              ? [
                  {
                    label: input.kind === "ac_sweep" ? `|V(${targetNode})|` : `V(${targetNode})`,
                    unit: input.kind === "ac_sweep" ? "dB" : "V",
                    points,
                  },
                ]
              : [],
          metrics: [],
          notes: [`Simulated using local ngspice (${executable}).`],
          simulatedAt: DateTime.formatIso(yield* DateTime.now),
        } satisfies ElectronicsSimulationResult;
      }),
    ).pipe(Effect.orElseSucceed(() => null as ElectronicsSimulationResult | null));
  },
);
