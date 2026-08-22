#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - captures host disclosure metadata for a contributor-run benchmark.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  AgentAppProfileId,
  decodeAgentAppCorpus,
  EnvironmentDisclosure,
  type AgentAppProfileId as AgentAppProfileIdType,
  type AgentAppCorpusManifest,
  type AgentAppScenarioId,
  type EnvironmentDisclosure as EnvironmentDisclosureType,
} from "./lib/agent-app-benchmark/contracts.ts";
import {
  canonicalJson,
  generatePublicCorpus,
  readCorpusGeneratorConfig,
  serializeCorpus,
  validateCorpusIntegrity,
} from "./lib/agent-app-benchmark/corpus.ts";
import { runBenchmarkAttempt, type RunProfile } from "./lib/agent-app-benchmark/runner.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = NodePath.join(REPO_ROOT, "benchmarks/agent-app/corpora/core-v1.json");
const DEFAULT_DRIVER = NodePath.join(REPO_ROOT, "scripts/lib/agent-app-benchmark/drivers/t3.ts");
const DEFAULT_OUTPUT = NodePath.join(REPO_ROOT, "artifacts/agent-app-benchmark");
const DEFAULT_RESOURCE_MONITOR = NodePath.join(
  REPO_ROOT,
  `native/resource-monitor/target/release/t3-resource-monitor${NodeProcess.platform === "win32" ? ".exe" : ""}`,
);

const PROFILE_SCENARIOS = {
  "workspace-core-v1": ["app-cold-ready-v1", "work-item-cold-open-v1", "work-item-warm-switch-v1"],
  "resource-core-v1": ["resource-sweep-v1", "resource-quiescence-v1"],
} as const satisfies Record<AgentAppProfileIdType, ReadonlyArray<AgentAppScenarioId>>;

export function scenariosForProfiles(
  profiles: ReadonlyArray<AgentAppProfileIdType>,
): ReadonlyArray<AgentAppScenarioId> {
  return profiles.flatMap((profile) => PROFILE_SCENARIOS[profile]);
}

export function resolveDriverCommand(
  driverPath: string,
  nodeExecutable = NodeProcess.execPath,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return /\.(?:[cm]?js|ts)$/u.test(driverPath)
    ? { command: nodeExecutable, args: [driverPath] }
    : { command: driverPath, args: [] };
}

function parseProfiles(value: string): ReadonlyArray<AgentAppProfileIdType> {
  const decode = Schema.decodeUnknownSync(AgentAppProfileId);
  const profiles = value
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => profile.length > 0)
    .map((profile) => decode(profile));
  if (profiles.length === 0) throw new Error("At least one profile is required.");
  if (new Set(profiles).size !== profiles.length) throw new Error("Profiles must not be repeated.");
  return profiles;
}

async function materializeCorpus(
  inputPath: string,
  outputDirectory: string,
): Promise<{
  readonly path: string;
  readonly corpusId: string;
  readonly digestSha256: string;
  readonly manifest: AgentAppCorpusManifest;
}> {
  await NodeFSP.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(outputDirectory, 0o700);
  const parsed = JSON.parse(await NodeFSP.readFile(inputPath, "utf8")) as unknown;
  const corpus =
    typeof parsed === "object" && parsed !== null && "kind" in parsed
      ? decodeAgentAppCorpus(parsed)
      : generatePublicCorpus(await readCorpusGeneratorConfig(inputPath));
  validateCorpusIntegrity(corpus);
  if (!(typeof parsed === "object" && parsed !== null && "kind" in parsed)) {
    const config = await readCorpusGeneratorConfig(inputPath);
    if (canonicalJson(config.expectedManifest) !== canonicalJson(corpus.manifest)) {
      throw new Error("Generated public corpus does not match the committed expected manifest.");
    }
  }
  const destination = NodePath.join(
    outputDirectory,
    `corpus-${corpus.corpusId}-${corpus.manifest.hashes.corpusSha256.slice(0, 12)}.json`,
  );
  await NodeFSP.writeFile(destination, serializeCorpus(corpus), { encoding: "utf8", mode: 0o600 });
  return {
    path: destination,
    corpusId: corpus.corpusId,
    digestSha256: corpus.manifest.hashes.corpusSha256,
    manifest: corpus.manifest,
  };
}

/**
 * Fields a Node process cannot observe. The disclosure schema requires
 * concrete positive numbers, so these carry placeholders — but they are
 * declared, not measured, and every report says so rather than printing them
 * as host facts. Pass `--environment` to state the real values.
 */
export const DECLARED_ENVIRONMENT_FIELDS = [
  "displayRefreshHz",
  "displayScale",
  "window",
  "colorScheme",
  "reducedMotion",
] as const;

export const DECLARED_ENVIRONMENT_LIMITATION =
  `Display, window, and appearance disclosure (${DECLARED_ENVIRONMENT_FIELDS.join(", ")}) was ` +
  "declared by the benchmark CLI, not measured on this host; supply --environment to disclose " +
  "the real values.";

function captureEnvironment(): EnvironmentDisclosureType {
  return {
    capturedAt: new Date().toISOString(),
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone benchmark CLI captures the actual host runtime.
    os: `${NodeOS.platform()} ${NodeOS.release()}`,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone benchmark CLI captures the actual host runtime.
    architecture: NodeOS.arch(),
    cpuModel: NodeOS.cpus()[0]?.model ?? "unknown",
    logicalCoreCount: Math.max(1, NodeOS.cpus().length),
    physicalMemoryBytes: NodeOS.totalmem(),
    displayRefreshHz: 60,
    displayScale: 1,
    powerSource: "unknown",
    thermalState: "unknown",
    window: { width: 1_440, height: 900 },
    colorScheme: "dark",
    reducedMotion: true,
    launchFlags: [],
  };
}

const decodeEnvironmentDisclosure = Schema.decodeUnknownSync(EnvironmentDisclosure);

async function loadEnvironment(path: string | undefined): Promise<{
  readonly environment: EnvironmentDisclosureType;
  readonly limitations: ReadonlyArray<string>;
}> {
  if (path !== undefined) {
    return {
      environment: decodeEnvironmentDisclosure(JSON.parse(await NodeFSP.readFile(path, "utf8"))),
      limitations: [],
    };
  }
  NodeProcess.stderr.write(`${DECLARED_ENVIRONMENT_LIMITATION}\n`);
  return { environment: captureEnvironment(), limitations: [DECLARED_ENVIRONMENT_LIMITATION] };
}

export interface BenchmarkCliInput {
  readonly appDriver: string;
  readonly corpus: string;
  readonly profiles: string;
  readonly runProfile: RunProfile;
  readonly seed: number;
  readonly output: string;
  readonly environment: string | undefined;
  readonly diagnostic: boolean;
  readonly resourceMonitor: string;
  readonly shareableReport: boolean;
}

class AgentAppBenchmarkCliError extends Schema.TaggedErrorClass<AgentAppBenchmarkCliError>()(
  "AgentAppBenchmarkCliError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : "Agent-app benchmark failed.";
  }
}

export async function runBenchmarkCli(input: BenchmarkCliInput): Promise<string> {
  if (input.runProfile === "publication" && input.environment === undefined) {
    throw new Error("Publication benchmarks require an explicit --environment disclosure file.");
  }
  const profiles = parseProfiles(input.profiles);
  const outputDirectory = NodePath.resolve(input.output);
  const corpus = await materializeCorpus(NodePath.resolve(input.corpus), outputDirectory);
  const driver = resolveDriverCommand(NodePath.resolve(input.appDriver));
  const disclosure = await loadEnvironment(input.environment);
  const result = await runBenchmarkAttempt({
    driver: { id: NodePath.basename(input.appDriver), ...driver, cwd: REPO_ROOT },
    corpusPath: corpus.path,
    corpusId: corpus.corpusId,
    corpusDigestSha256: corpus.digestSha256,
    corpusManifest: corpus.manifest,
    outputDirectory,
    profiles,
    scenarios: scenariosForProfiles(profiles),
    runProfile: input.runProfile,
    seed: input.seed,
    environment: disclosure.environment,
    extraLimitations: disclosure.limitations,
    diagnostic: input.diagnostic,
    resourceMonitorPath: NodePath.resolve(input.resourceMonitor),
    shareableReport: input.shareableReport,
  });
  return result.reportPath;
}

export const agentAppBenchmarkCommand = Command.make(
  "agent-app-benchmark",
  {
    appDriver: Flag.string("app-driver").pipe(
      Flag.withDescription("Executable app driver or a JavaScript/TypeScript driver entrypoint."),
      Flag.withDefault(DEFAULT_DRIVER),
    ),
    corpus: Flag.string("corpus").pipe(
      Flag.withDescription("Generated corpus JSON or public corpus generator config."),
      Flag.withDefault(DEFAULT_CONFIG),
    ),
    profiles: Flag.string("profiles").pipe(
      Flag.withDescription("Comma-separated capability profiles."),
      Flag.withDefault("workspace-core-v1"),
    ),
    runProfile: Flag.choice("run-profile", ["smoke", "quick", "publication"]).pipe(
      Flag.withDescription("Warm-up and measured-run profile."),
      Flag.withDefault("quick"),
    ),
    seed: Flag.integer("seed").pipe(
      Flag.withDescription("Deterministic ordering seed."),
      Flag.withDefault(1),
    ),
    output: Flag.string("output").pipe(
      Flag.withDescription("Owner-readable benchmark artifact root."),
      Flag.withDefault(DEFAULT_OUTPUT),
    ),
    environment: Flag.string("environment").pipe(
      Flag.withDescription("Environment disclosure JSON; required for publication-quality claims."),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    resourceMonitor: Flag.string("resource-monitor").pipe(
      Flag.withDescription("Standalone native resource-monitor executable."),
      Flag.withDefault(DEFAULT_RESOURCE_MONITOR),
    ),
    diagnostic: Flag.boolean("diagnostic").pipe(
      Flag.withDescription("Run one separately labeled diagnostic rerun after primary samples."),
      Flag.withDefault(false),
    ),
    shareableReport: Flag.boolean("shareable-report").pipe(
      Flag.withDescription(
        "Validate the aggregate report against the closed-field privacy scanner; raw artifacts remain private.",
      ),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.tryPromise({
      try: () => runBenchmarkCli(input),
      catch: (cause) => new AgentAppBenchmarkCliError({ cause }),
    }).pipe(
      Effect.tap((reportPath) => Effect.sync(() => NodeProcess.stdout.write(`${reportPath}\n`))),
    ),
).pipe(
  Command.withDescription(
    "Run a reproducible local-desktop agent-app benchmark without performance thresholds.",
  ),
);

if (import.meta.main) {
  Command.run(agentAppBenchmarkCommand, { version: "1.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
