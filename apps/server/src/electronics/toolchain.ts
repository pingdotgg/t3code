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
  /\b(?:filesource|d_source|d_process|d_cosim|d_state|d_lut|table2d|table3d|tablefile|file_name|shell|system|wrdata|write)\b|[a-z0-9_]*file[a-z0-9_]*\s*=|\bsimulation\s*=/iu;

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
      const exitCode = Number(yield* child.exitCode);
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
      return { text, truncated, exitCode };
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
    Effect.map((res) =>
      res.exitCode === 0
        ? { ok: true as const, raw: res.text }
        : { ok: false as const, err: `${name} exited with status ${res.exitCode}` },
    ),
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

export function sanitizeSpiceDeckLines(
  spiceSource: string,
  options: { readonly allowTitleLine?: boolean } = {},
): {
  readonly lines: string[];
  readonly blockedReasons: string[];
} {
  const allowTitleLine = options.allowTitleLine ?? true;
  // Join SPICE '+' continuation lines into logical lines before validating directives/tokens
  // so attackers cannot split `.codemodel` or `filesource(file=...)` across lines.
  // Never merge a '+' continuation onto an exempted root title line (idx === 0).
  const rawLines = spiceSource.split(/\r?\n/u);
  const logicalLines: Array<{ readonly text: string; readonly isTitle: boolean }> = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i]!;
    const trimmed = rawLine.trim();
    if (i === 0 && allowTitleLine && !trimmed.startsWith(".")) {
      logicalLines.push({ text: rawLine, isTitle: true });
      continue;
    }
    const prev = logicalLines[logicalLines.length - 1];
    if (
      prev !== undefined &&
      !prev.isTitle &&
      trimmed.startsWith("+") &&
      !prev.text.trim().startsWith("*")
    ) {
      logicalLines[logicalLines.length - 1] = {
        text: `${prev.text} ${trimmed.slice(1).trim()}`,
        isTitle: false,
      };
    } else {
      logicalLines.push({ text: rawLine, isTitle: false });
    }
  }

  const output: string[] = [];
  const blockedReasons: string[] = [];
  let inControlBlock = false;
  for (const entry of logicalLines) {
    if (entry.isTitle) {
      // Drop the original title line; runNgspiceSimulation always emits a fixed constant title.
      continue;
    }
    const trimmed = entry.text.trim();
    // Strip all '*' comment lines completely so ngspice '*#' / '*$' comment-prefixed control
    // commands can never execute outside a .control block.
    if (trimmed.length === 0 || trimmed.startsWith("*")) {
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
        UNSAFE_ELEMENT_PATTERN.test(trimmed)
      ) {
        blockedReasons.push(
          `Disallowed external file/command token in SPICE ${directive} directive.`,
        );
        continue;
      }
      output.push(trimmed);
      continue;
    }

    // Block XSPICE A-elements (d_process, d_cosim, filesource, etc.) in sandboxed runs
    if (/^a\S*\s/iu.test(trimmed)) {
      blockedReasons.push("Disallowed XSPICE A-element in sandboxed external simulation.");
      continue;
    }

    if (UNSAFE_ELEMENT_PATTERN.test(trimmed)) {
      blockedReasons.push("Disallowed external file/command token in SPICE element line.");
      continue;
    }
    output.push(trimmed);
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
  let inVoltageSection = false;
  let readVoltageRowInSection = false;

  for (const line of stdout.split(/\r?\n/u)) {
    if (kind === "dc_op") {
      if (/^\s*Node\s+Voltage\s*$/iu.test(line)) {
        inVoltageSection = true;
        readVoltageRowInSection = false;
        continue;
      }
      if (/^\s*-+\s+-+\s*$/u.test(line)) {
        continue;
      }
      if (inVoltageSection && line.trim().length === 0 && readVoltageRowInSection) {
        inVoltageSection = false;
        continue;
      }
      if (/^\s*(?:Source|Branch)\s+Current\s*$/iu.test(line)) {
        inVoltageSection = false;
        continue;
      }

      // Handle `v(out) = 2.500000e+00`, `out = 2.5`
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

      // Handle tabular `Node   Voltage` rows (including numeric SPICE node names inside the section)
      const tabMatch = /^\s*([A-Za-z0-9_.:+-]+)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/iu.exec(
        line,
      );
      if (tabMatch) {
        const node = tabMatch[1]!;
        const val = Number(tabMatch[2]!);
        const isPureInteger = /^\d+$/u.test(node);
        if (
          Number.isFinite(val) &&
          !seenNodes.has(node.toLowerCase()) &&
          !/^(index|temp|tnom)$/iu.test(node) &&
          (inVoltageSection || !isPureInteger)
        ) {
          if (inVoltageSection) readVoltageRowInSection = true;
          seenNodes.add(node.toLowerCase());
          nodeVoltages.push({ node, voltageV: Number(val.toPrecision(6)) });
        }
      }
      continue;
    }

    if (points.length >= MAX_SIMULATION_POINTS) break;

    // Handle AC comma-separated complex tuples with optional whitespace after comma
    // (e.g. `0 1.0e+01 -3.01,\t0.00 -0.7854,  0.00`) and whitespace-separated columns.
    const rowPrefix = /^\s*\d+\s+(.+)$/u.exec(line);
    if (!rowPrefix) continue;
    const tokens = rowPrefix[1]!.trim().replace(/,\s+/gu, ",").split(/\s+/u);
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

export type SpiceDeckExpansionResult =
  | { readonly ok: true; readonly lines: ReadonlyArray<string>; readonly includedCount: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Recursively validates and inlines all workspace-contained `.include`/`.inc`/`.lib` files
 * so the resulting deck contains ZERO external file references and passes a final sanitization pass.
 */
export const expandSpiceWorkspaceDeck = Effect.fn("ElectronicsToolchain.expandSpiceWorkspaceDeck")(
  function* (input: {
    readonly spiceSource: string;
    readonly workspaceRoot: string;
    readonly sourceFilePath: string;
  }): Effect.fn.Return<SpiceDeckExpansionResult, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootReal = yield* fs.realPath(input.workspaceRoot).pipe(Effect.orElseSucceed(() => null));
    if (rootReal === null) {
      return { ok: false as const, reason: "Workspace root could not be resolved." };
    }
    const includedCountRef = { count: 0 };

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
      const { lines, blockedReasons } = sanitizeSpiceDeckLines(sourceText, {
        allowTitleLine: depth === 0,
      });
      if (blockedReasons.length > 0) {
        return { ok: false as const, reason: blockedReasons[0]! };
      }
      const expanded: string[] = [];
      for (const line of lines) {
        if (!/^\s*\.(include|inc|lib)\b/iu.test(line)) {
          expanded.push(line);
          continue;
        }
        const incMatch =
          /^\s*\.(include|inc|lib)\s+("([^"]+)"|'([^']+)'|(\S+))(?:\s+(\S+))?\s*$/iu.exec(line);
        if (!incMatch) {
          return {
            ok: false as const,
            reason: `Malformed SPICE include/lib directive: "${line.slice(0, 80)}".`,
          };
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
        const exists = yield* fs.exists(resolvedCandidate).pipe(Effect.orElseSucceed(() => false));
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
        if (stat === null || stat.type !== "File" || Number(stat.size) > MAX_INCLUDE_FILE_BYTES) {
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

    const resolvedSource = yield* fs
      .realPath(input.sourceFilePath)
      .pipe(Effect.orElseSucceed(() => path.resolve(input.sourceFilePath)));
    const expanded = yield* expandSource(
      input.spiceSource,
      path.dirname(resolvedSource),
      0,
      new Set<string>([resolvedSource]),
    );
    if (!expanded.ok) return expanded;

    // Final sanitization pass over the fully expanded deck to catch cross-file '+' continuations
    const finalSanitized = sanitizeSpiceDeckLines(expanded.lines.join("\n"), {
      allowTitleLine: false,
    });
    if (finalSanitized.blockedReasons.length > 0) {
      return { ok: false as const, reason: finalSanitized.blockedReasons[0]! };
    }
    if (finalSanitized.lines.some((line) => /^\s*\.(include|inc|lib)\b/iu.test(line))) {
      return {
        ok: false as const,
        reason: "Unresolved SPICE include/lib directive remained after expansion.",
      };
    }

    return {
      ok: true as const,
      lines: finalSanitized.lines,
      includedCount: includedCountRef.count,
    };
  },
);

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
        const expanded = yield* expandSpiceWorkspaceDeck({
          spiceSource: input.spiceSource,
          workspaceRoot: input.workspaceRoot,
          sourceFilePath: input.sourceFilePath,
        });
        if (!expanded.ok) {
          return { result: null, rejectionNote: expanded.reason };
        }

        const deckPath = path.join(tmpDir, "deck.cir");
        const requestedNode = input.outputNode?.trim();
        const canonicalRequested =
          requestedNode !== undefined
            ? requestedNode.toLowerCase() === "0" || requestedNode.toLowerCase() === "gnd"
              ? "GND"
              : requestedNode.toLowerCase()
            : undefined;
        const targetNode =
          canonicalRequested ?? input.model.nets.find((n) => !n.isGround)?.name ?? "out";
        if (!/^[A-Za-z0-9_.:+-]+$/u.test(targetNode)) {
          return { result: null, rejectionNote: `Invalid probe node name "${targetNode}".` };
        }

        const startFreq = input.startFreqHz ?? 10;
        const stopFreq = input.stopFreqHz ?? Math.max(1_000_000, startFreq * 10);
        if (
          input.kind === "ac_sweep" &&
          (!Number.isFinite(startFreq) ||
            !Number.isFinite(stopFreq) ||
            startFreq <= 0 ||
            stopFreq <= startFreq)
        ) {
          return {
            result: null,
            rejectionNote: "AC sweep requires positive finite startFreqHz < stopFreqHz.",
          };
        }
        const decades = Math.max(
          1e-3,
          Math.log10(Math.max(stopFreq, startFreq * 1.001) / startFreq),
        );
        const maxPtsPerDecade = Math.max(
          2,
          Math.floor(MAX_SIMULATION_POINTS / Math.max(1, decades)),
        );
        const ptsPerDecade = Math.min(input.pointsPerDecade ?? 10, maxPtsPerDecade, 50);

        const stopTime = input.stopTimeSeconds ?? 5e-3;
        if (input.kind === "transient" && (!Number.isFinite(stopTime) || stopTime <= 0)) {
          return {
            result: null,
            rejectionNote: "Transient stopTimeSeconds must be a positive finite number.",
          };
        }
        if (
          input.kind === "transient" &&
          input.stepTimeSeconds !== undefined &&
          (!Number.isFinite(input.stepTimeSeconds) || input.stepTimeSeconds <= 0)
        ) {
          return {
            result: null,
            rejectionNote: "Transient stepTimeSeconds must be a positive finite number.",
          };
        }
        const minStep = stopTime / MAX_SIMULATION_POINTS;
        const stepTime = Math.max(minStep, input.stepTimeSeconds ?? stopTime / 100);

        const directive =
          input.kind === "dc_op"
            ? ".op\n.print op all"
            : input.kind === "ac_sweep"
              ? `.ac dec ${ptsPerDecade} ${startFreq} ${stopFreq}\n.print ac vdb(${targetNode}) vp(${targetNode})`
              : `.tran ${stepTime} ${stopTime}\n.print tran v(${targetNode})`;

        const deck = `* t3code ngspice batch deck\n${expanded.lines.join("\n")}\n${directive}\n.end\n`;
        yield* fs.writeFileString(deckPath, deck);

        // Pass -n (--no-spiceinit) so user/workspace .spiceinit scripts cannot execute.
        const {
          text: stdout,
          truncated,
          exitCode,
        } = yield* execToolString(executable, ["-n", "-b", deckPath], RUN_TIMEOUT, tmpDir);
        if (exitCode !== 0) {
          return {
            result: null,
            rejectionNote: `ngspice exited with non-zero status ${exitCode}.`,
          };
        }
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
