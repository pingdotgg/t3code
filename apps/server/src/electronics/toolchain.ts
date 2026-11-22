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
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const PROBE_TIMEOUT = Duration.seconds(5);
const RUN_TIMEOUT = Duration.seconds(20);
const MAX_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INCLUDE_FILES = 16;
const MAX_INCLUDE_DEPTH = 4;
const MAX_INCLUDE_FILE_BYTES = 256 * 1024;
const MAX_SIMULATION_POINTS = 2_000;

const ALLOWED_SPICE_DIRECTIVES: ReadonlySet<string> = new Set([
  ".title",
  ".param",
  ".model",
  ".subckt",
  ".ends",
  ".temp",
  ".global",
  ".ic",
  ".nodeset",
  ".options",
  ".option",
  ".include",
  ".inc",
  ".lib",
]);

const STRIPPED_ANALYSIS_DIRECTIVES: ReadonlySet<string> = new Set([
  ".end",
  ".op",
  ".ac",
  ".tran",
  ".dc",
  ".print",
  ".plot",
  ".probe",
  ".save",
]);

const UNSAFE_ELEMENT_PATTERN =
  /\b(?:filesource|d_source|tablefile|file_name|shell|system|wrdata|write)\b|\b(?:file|input_file|output_file)\s*=/iu;

function isWithinRoot(pathApi: Path.Path, rootReal: string, candidate: string): boolean {
  const rel = pathApi.relative(rootReal, candidate);
  if (rel === "") return true;
  if (pathApi.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !rel.startsWith("../");
}

/**
 * Executes a single command without a shell and captures up to MAX_TOOL_OUTPUT_BYTES of stdout.
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
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(command);
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;
      yield* Stream.runForEach(child.stdout, (chunk) =>
        Effect.sync(() => {
          if (totalBytes >= MAX_TOOL_OUTPUT_BYTES) {
            truncated = true;
            return;
          }
          const remaining = MAX_TOOL_OUTPUT_BYTES - totalBytes;
          if (chunk.byteLength <= remaining) {
            chunks.push(chunk);
            totalBytes += chunk.byteLength;
          } else {
            chunks.push(chunk.subarray(0, remaining));
            totalBytes += remaining;
            truncated = true;
          }
        }),
      );
      yield* child.exitCode.pipe(Effect.ignore);
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
      return { text, truncated };
    }),
  ).pipe(Effect.timeout(timeout));
});

export const probeBinary = Effect.fn("ElectronicsToolchain.probeBinary")(function* (
  name: "kicad-cli" | "ngspice",
  overridePath?: string,
): Effect.fn.Return<ElectronicsToolBinaryStatus, never, ChildProcessSpawner.ChildProcessSpawner> {
  const executable = overridePath && overridePath.trim().length > 0 ? overridePath.trim() : name;
  const args = name === "kicad-cli" ? ["--version"] : ["-n", "-v"];
  const output = yield* execToolString(executable, args, PROBE_TIMEOUT).pipe(
    Effect.map((res) => ({ ok: true as const, raw: res.text })),
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

export function parseKiCadJsonViolations(
  jsonText: string,
  source: "kicad_erc" | "kicad_drc",
):
  | { readonly valid: true; readonly issues: ElectronicsValidationIssue[] }
  | { readonly valid: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { valid: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false };
  }

  const violations: KiCadViolationRaw[] = [];
  const obj = parsed as {
    violations?: unknown;
    unconnected_items?: unknown;
    sheets?: unknown;
  };

  const hasExpectedContainer =
    Array.isArray(obj.violations) ||
    Array.isArray(obj.unconnected_items) ||
    Array.isArray(obj.sheets);
  if (!hasExpectedContainer) {
    return { valid: false };
  }

  if (Array.isArray(obj.violations)) violations.push(...(obj.violations as KiCadViolationRaw[]));
  if (Array.isArray(obj.unconnected_items)) {
    violations.push(...(obj.unconnected_items as KiCadViolationRaw[]));
  }
  if (Array.isArray(obj.sheets)) {
    for (const sheet of obj.sheets as Array<{ violations?: unknown }>) {
      if (Array.isArray(sheet?.violations)) {
        violations.push(...(sheet.violations as KiCadViolationRaw[]));
      }
    }
  }

  return {
    valid: true,
    issues: violations.map((v, idx) => {
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
    }),
  };
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
      const parsedReport = parseKiCadJsonViolations(reportText, source);
      if (!parsedReport.valid) {
        return {
          ran: false,
          source,
          issues: [] as ElectronicsValidationIssue[],
          note: `kicad-cli produced an invalid or truncated JSON ${source === "kicad_erc" ? "ERC" : "DRC"} report.`,
        };
      }
      return {
        ran: true,
        source,
        issues: parsedReport.issues,
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

export function sanitizeSpiceDeckLines(spiceSource: string): {
  readonly lines: string[];
  readonly blockedReasons: string[];
} {
  // Join SPICE '+' continuation lines into logical lines before validating directives/tokens
  // so attackers cannot split `.codemodel` or `filesource(file=...)` across lines.
  const logicalLines: string[] = [];
  for (const rawLine of spiceSource.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (
      logicalLines.length > 0 &&
      trimmed.startsWith("+") &&
      !logicalLines[logicalLines.length - 1]!.trim().startsWith("*")
    ) {
      logicalLines[logicalLines.length - 1] =
        `${logicalLines[logicalLines.length - 1]} ${trimmed.slice(1).trim()}`;
    } else {
      logicalLines.push(rawLine);
    }
  }

  const output: string[] = [];
  const blockedReasons: string[] = [];
  let inControlBlock = false;
  for (let idx = 0; idx < logicalLines.length; idx += 1) {
    const rawLine = logicalLines[idx]!;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("*")) {
      output.push(rawLine);
      continue;
    }
    // Line 0 is the SPICE title line unless it starts with a directive dot.
    if (idx === 0 && !trimmed.startsWith(".")) {
      output.push(rawLine);
      continue;
    }
    if (/^\.control\b/iu.test(trimmed)) {
      inControlBlock = true;
      blockedReasons.push("Disallowed SPICE directive: .control");
      continue;
    }
    if (/^\.endc\b/iu.test(trimmed)) {
      inControlBlock = false;
      continue;
    }
    if (inControlBlock) continue;

    const codePart = trimmed.split(";")[0] ?? trimmed;

    if (trimmed.startsWith(".")) {
      const directive = (trimmed.split(/\s+/u)[0] ?? "").toLowerCase();
      if (STRIPPED_ANALYSIS_DIRECTIVES.has(directive)) {
        continue;
      }
      if (!ALLOWED_SPICE_DIRECTIVES.has(directive)) {
        blockedReasons.push(`Disallowed SPICE directive: ${directive}`);
        continue;
      }
      if (
        directive !== ".include" &&
        directive !== ".inc" &&
        directive !== ".lib" &&
        UNSAFE_ELEMENT_PATTERN.test(codePart)
      ) {
        blockedReasons.push(
          `Disallowed external file/command token in SPICE ${directive} directive.`,
        );
        continue;
      }
      output.push(rawLine);
      continue;
    }

    if (UNSAFE_ELEMENT_PATTERN.test(codePart)) {
      blockedReasons.push("Disallowed external file/command token in SPICE element line.");
      continue;
    }
    output.push(rawLine);
  }
  return { lines: output, blockedReasons };
}

export function parseNgspiceBatchOutput(
  stdout: string,
  kind: ElectronicsSimulationKind,
): {
  readonly nodeVoltages: Array<{ node: string; voltageV: number }>;
  readonly points: Array<{ x: number; y: number; phaseDeg?: number }>;
} {
  const nodeVoltages: Array<{ node: string; voltageV: number }> = [];
  const seenNodes = new Set<string>();
  const points: Array<{ x: number; y: number; phaseDeg?: number }> = [];

  for (const line of stdout.split(/\r?\n/u)) {
    if (kind === "dc_op") {
      // Handle `v(out) = 2.500000e+00`, `out = 2.5`, or tabular `out   2.500000e+00`
      const eqMatch =
        /^\s*(?:v\(([^)]+)\)|([A-Za-z0-9_.:+-]+))\s*=\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/iu.exec(
          line,
        );
      if (eqMatch) {
        const node = (eqMatch[1] ?? eqMatch[2] ?? "").trim();
        const val = Number(eqMatch[3]!);
        if (
          node.length > 0 &&
          Number.isFinite(val) &&
          !seenNodes.has(node.toLowerCase()) &&
          !/^(index|temp|tnom)$/iu.test(node)
        ) {
          seenNodes.add(node.toLowerCase());
          nodeVoltages.push({ node, voltageV: Number(val.toPrecision(6)) });
        }
        continue;
      }
      const tabMatch = /^\s*([A-Za-z0-9_.:+-]+)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/iu.exec(
        line,
      );
      if (tabMatch) {
        const node = tabMatch[1]!;
        const val = Number(tabMatch[2]!);
        if (
          Number.isFinite(val) &&
          !seenNodes.has(node.toLowerCase()) &&
          !/^(index|temp|tnom|\d+)$/iu.test(node)
        ) {
          seenNodes.add(node.toLowerCase());
          nodeVoltages.push({ node, voltageV: Number(val.toPrecision(6)) });
        }
      }
      continue;
    }

    if (points.length >= MAX_SIMULATION_POINTS) break;

    // Handle AC comma-separated complex tuples (e.g. `0 1.0e+01 0.0,0.0 -0.05,0.0`)
    // and whitespace-separated columns (`0 1.0e+01 -3.01 -0.7854`).
    const rowPrefix = /^\s*\d+\s+(.+)$/u.exec(line);
    if (!rowPrefix) continue;
    const tokens = rowPrefix[1]!.trim().split(/\s+/u);
    const parseScalar = (tok: string | undefined): number | null => {
      if (!tok) return null;
      const realPart = tok.split(",")[0]!;
      const num = Number(realPart);
      return Number.isFinite(num) ? num : null;
    };
    const xVal = parseScalar(tokens[0]);
    const yVal = parseScalar(tokens[1]);
    const thirdRaw = parseScalar(tokens[2]);
    if (xVal !== null && yVal !== null) {
      // ngspice vp(...) outputs phase in radians by default
      const phaseDeg =
        kind === "ac_sweep" && thirdRaw !== null
          ? Number(((thirdRaw * 180) / Math.PI).toFixed(2))
          : undefined;
      points.push({
        x: kind === "transient" ? Number((xVal * 1000).toPrecision(5)) : xVal,
        y: Number(yVal.toPrecision(5)),
        ...(phaseDeg !== undefined ? { phaseDeg } : {}),
      });
    }
  }

  return { nodeVoltages, points };
}

export interface NgspiceRunOutcome {
  readonly result: ElectronicsSimulationResult | null;
  readonly rejectionNote?: string;
}

export const runNgspiceSimulation = Effect.fn("ElectronicsToolchain.runNgspiceSimulation")(
  function* (input: {
    readonly model: ElectronicsCircuitModel;
    readonly spiceSource: string;
    readonly workspaceRoot: string;
    readonly sourceFilePath: string;
    readonly kind: ElectronicsSimulationKind;
    readonly ngspicePath?: string;
    readonly outputNode?: string;
    readonly startFreqHz?: number;
    readonly stopFreqHz?: number;
    readonly pointsPerDecade?: number;
    readonly stopTimeSeconds?: number;
    readonly stepTimeSeconds?: number;
  }): Effect.fn.Return<
    NgspiceRunOutcome,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executable =
      input.ngspicePath && input.ngspicePath.trim().length > 0
        ? input.ngspicePath.trim()
        : "ngspice";

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ngspice-" });
        const rootReal = yield* fs.realPath(input.workspaceRoot);
        const includedCountRef = { count: 0 };

        // Recursively validate and inline all workspace-contained .include/.inc/.lib files so
        // the deck passed to ngspice contains ZERO external file references.
        const expandSource: (
          sourceText: string,
          currentDir: string,
          depth: number,
          activeStack: ReadonlySet<string>,
        ) => Effect.Effect<
          | { readonly ok: true; readonly lines: string[] }
          | { readonly ok: false; readonly reason: string }
        > = Effect.fn("ElectronicsToolchain.expandSpiceIncludes")(function* (
          sourceText: string,
          currentDir: string,
          depth: number,
          activeStack: ReadonlySet<string>,
        ) {
          if (depth > MAX_INCLUDE_DEPTH) {
            return { ok: false as const, reason: "SPICE include nesting depth limit exceeded." };
          }
          const { lines, blockedReasons } = sanitizeSpiceDeckLines(sourceText);
          if (blockedReasons.length > 0) {
            return { ok: false as const, reason: blockedReasons[0]! };
          }
          const expanded: string[] = [];
          for (const line of lines) {
            const incMatch =
              /^\s*\.(include|inc|lib)\s+("([^"]+)"|'([^']+)'|(\S+))(?:\s+(\S+))?/iu.exec(line);
            if (!incMatch) {
              expanded.push(line);
              continue;
            }
            const directiveName = incMatch[1]!.toLowerCase();
            const refPath = incMatch[3] ?? incMatch[4] ?? incMatch[5] ?? "";
            const libSection = incMatch[6];
            if (directiveName === "lib" && libSection !== undefined) {
              return {
                ok: false as const,
                reason: "Sectioned .lib directives are not supported in sandboxed external runs.",
              };
            }
            const baseName = path.basename(refPath).toLowerCase();
            if (
              refPath.length === 0 ||
              path.isAbsolute(refPath) ||
              baseName === ".spiceinit" ||
              baseName === "spiceinit"
            ) {
              return {
                ok: false as const,
                reason: `Disallowed SPICE include path "${refPath}".`,
              };
            }
            if (includedCountRef.count >= MAX_INCLUDE_FILES) {
              return { ok: false as const, reason: "Too many SPICE include files." };
            }
            const resolvedCandidate = path.resolve(currentDir, refPath);
            if (!isWithinRoot(path, rootReal, resolvedCandidate)) {
              return {
                ok: false as const,
                reason: `SPICE include "${refPath}" escapes the workspace root.`,
              };
            }
            const exists = yield* fs
              .exists(resolvedCandidate)
              .pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              return {
                ok: false as const,
                reason: `SPICE include "${refPath}" was not found.`,
              };
            }
            const realCandidate = yield* fs
              .realPath(resolvedCandidate)
              .pipe(Effect.orElseSucceed(() => null));
            if (realCandidate === null || !isWithinRoot(path, rootReal, realCandidate)) {
              return {
                ok: false as const,
                reason: `SPICE include "${refPath}" resolves outside the workspace root.`,
              };
            }
            if (activeStack.has(realCandidate)) {
              return { ok: false as const, reason: `Cyclic SPICE include "${refPath}".` };
            }
            const stat = yield* fs.stat(realCandidate).pipe(Effect.orElseSucceed(() => null));
            if (
              stat === null ||
              stat.type !== "File" ||
              Number(stat.size) > MAX_INCLUDE_FILE_BYTES
            ) {
              return {
                ok: false as const,
                reason: `SPICE include "${refPath}" is not a valid file within size limits.`,
              };
            }
            includedCountRef.count += 1;
            const incText = yield* fs
              .readFileString(realCandidate)
              .pipe(Effect.orElseSucceed(() => null));
            if (incText === null) {
              return {
                ok: false as const,
                reason: `Failed to read SPICE include "${refPath}".`,
              };
            }
            const nextStack = new Set(activeStack);
            nextStack.add(realCandidate);
            const nested = yield* expandSource(
              incText,
              path.dirname(realCandidate),
              depth + 1,
              nextStack,
            );
            if (!nested.ok) return nested;
            expanded.push(...nested.lines);
          }
          return { ok: true as const, lines: expanded };
        });

        const initialStack = new Set<string>([path.resolve(input.sourceFilePath)]);
        const expanded = yield* expandSource(
          input.spiceSource,
          path.dirname(path.resolve(input.sourceFilePath)),
          0,
          initialStack,
        );
        if (!expanded.ok) {
          return { result: null, rejectionNote: expanded.reason };
        }

        const deckPath = path.join(tmpDir, "deck.cir");
        const targetNode =
          input.outputNode ?? input.model.nets.find((n) => !n.isGround)?.name ?? "out";
        if (!/^[A-Za-z0-9_.:+-]+$/u.test(targetNode)) {
          return { result: null, rejectionNote: `Invalid probe node name "${targetNode}".` };
        }

        const startFreq = Math.max(0.1, input.startFreqHz ?? 10);
        const stopFreq = Math.max(startFreq * 10, input.stopFreqHz ?? 1_000_000);
        const decades = Math.max(1, Math.log10(stopFreq / startFreq));
        const maxPtsPerDecade = Math.max(2, Math.floor(MAX_SIMULATION_POINTS / decades));
        const ptsPerDecade = Math.min(input.pointsPerDecade ?? 10, maxPtsPerDecade, 50);

        const stopTime = Math.max(1e-9, input.stopTimeSeconds ?? 5e-3);
        const minStep = stopTime / MAX_SIMULATION_POINTS;
        const stepTime = Math.max(minStep, input.stepTimeSeconds ?? stopTime / 100);

        const directive =
          input.kind === "dc_op"
            ? ".op\n.print op all"
            : input.kind === "ac_sweep"
              ? `.ac dec ${ptsPerDecade} ${startFreq} ${stopFreq}\n.print ac vdb(${targetNode}) vp(${targetNode})`
              : `.tran ${stepTime} ${stopTime}\n.print tran v(${targetNode})`;

        const deck = `${expanded.lines.join("\n")}\n${directive}\n.end\n`;
        yield* fs.writeFileString(deckPath, deck);

        // Pass -n (--no-spiceinit) so user/workspace .spiceinit scripts cannot execute.
        const { text: stdout, truncated } = yield* execToolString(
          executable,
          ["-n", "-b", deckPath],
          RUN_TIMEOUT,
          tmpDir,
        );
        const { nodeVoltages, points } = parseNgspiceBatchOutput(stdout, input.kind);

        if (nodeVoltages.length === 0 && points.length === 0) {
          return {
            result: null,
            rejectionNote:
              "ngspice ran but produced no parseable operating-point or waveform output.",
          };
        }

        const notes = ["Simulated with local ngspice toolchain (-n -b)."];
        if (truncated) {
          notes.push("ngspice stdout was truncated at the 2 MiB output safety limit.");
        }

        return {
          result: {
            filePath: input.model.filePath,
            kind: input.kind,
            engine: "ngspice" as const,
            xAxisLabel:
              input.kind === "ac_sweep"
                ? "Frequency"
                : input.kind === "transient"
                  ? "Time"
                  : "Node",
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
            notes,
            simulatedAt: DateTime.formatIso(yield* DateTime.now),
          },
        };
      }),
    ).pipe(
      Effect.catch((err) =>
        Effect.succeed({
          result: null,
          rejectionNote: `ngspice execution failed: ${String(err).slice(0, 160)}`,
        }),
      ),
    );
  },
);
