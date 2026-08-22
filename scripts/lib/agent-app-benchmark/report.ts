// @effect-diagnostics nodeBuiltinImport:off - hashes portable benchmark artifacts.
import * as NodeCrypto from "node:crypto";

import {
  PRIMARY_METRIC_UNITS,
  type AgentAppProfileId,
  type AgentAppResultBundle,
  type AgentAppScenarioId,
  type ApplicationIdentity,
  type DriverIdentity,
  type EnvironmentDisclosure,
  type PrimaryMetricId,
  type ResourceTopology,
  type ValidityCheckEvidence,
} from "./contracts.ts";
import { bootstrapMedianInterval, median } from "./statistics.ts";

export type RunProfile = "smoke" | "quick" | "publication";

function measuredRunCount(profile: RunProfile): number {
  switch (profile) {
    case "smoke":
      return 3;
    case "quick":
      return 5;
    case "publication":
      return 20;
  }
}

export type ReportObservation =
  | { readonly state: "exact"; readonly value: number }
  | {
      readonly state: "bounded";
      readonly lowerBound?: number;
      readonly upperBound: number;
      readonly reason?: string;
    }
  | { readonly state: "unsupported"; readonly reason: string }
  | { readonly state: "invalid"; readonly reason: string };

export interface ReportSample {
  readonly attemptId: string;
  readonly appId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly phase: "warmup" | "measured" | "diagnostic";
  readonly runIndex: number;
  readonly metricId: string;
  readonly unit: string;
  readonly observation: ReportObservation;
  readonly valid: boolean;
  readonly failures: ReadonlyArray<ReportFailure>;
}

export interface ReportFailure {
  readonly code: string;
  readonly message: string;
  readonly evidence?: ReadonlyArray<ValidityCheckEvidence>;
}

export interface MeasurementMethodDisclosure {
  readonly profileId: AgentAppProfileId;
  readonly scenarioId: AgentAppScenarioId;
  readonly metricId: PrimaryMetricId;
  readonly clockOwner: string;
  readonly clockDomain: string;
  readonly observerMethod: string;
  readonly resolutionMs: number;
}

export interface MetricSummary {
  readonly appId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly metricId: string;
  readonly unit: string;
  readonly observationState: ReportObservation["state"] | "mixed";
  readonly measuredSamples: number;
  readonly invalidSamples: number;
  readonly rankable: boolean;
  readonly median?: number;
  readonly confidenceInterval?: { readonly low: number; readonly high: number };
  readonly lowerBound?: number;
  readonly upperBound?: number;
  readonly reason?: string;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly frameworkVersion: string | number;
  readonly runId?: string;
  readonly runProfile: RunProfile;
  readonly reportKind: "estimate" | "publication";
  readonly seed?: number;
  readonly rankable: boolean;
  readonly measuredSamples: number;
  readonly invalidMeasuredSamples: number;
  readonly failedAttempts: ReadonlyArray<{
    readonly attemptId: string;
    readonly phase: ReportSample["phase"];
    readonly profileId: string;
    readonly scenarioId: string;
    readonly metricId: string;
    readonly failures: ReadonlyArray<ReportFailure>;
  }>;
  readonly rawSamplesDigest: string;
  readonly metrics: ReadonlyArray<MetricSummary>;
  readonly corpus?: AgentAppResultBundle["corpus"];
  readonly application?: ApplicationIdentity;
  readonly driver?: DriverIdentity;
  readonly environment?: EnvironmentDisclosure;
  readonly profiles: ReadonlyArray<string>;
  readonly scenarios: ReadonlyArray<string>;
  readonly measurementMethods: ReadonlyArray<MeasurementMethodDisclosure>;
  readonly resourceTopology?: ResourceTopology;
  readonly limitations: ReadonlyArray<string>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Digest(value: unknown): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function summaryKey(sample: ReportSample): string {
  return [sample.appId, sample.profileId, sample.scenarioId, sample.metricId, sample.unit].join(
    "\u0000",
  );
}

function summarizeMetric(
  samples: ReadonlyArray<ReportSample>,
  expectedSamples: number,
  seed: number,
): MetricSummary {
  const first = samples[0]!;
  const states = new Set(samples.map((sample) => sample.observation.state));
  const observationState = states.size === 1 ? samples[0]!.observation.state : "mixed";
  const invalidSamples = samples.filter(
    (sample) => !sample.valid || sample.observation.state === "invalid",
  ).length;
  const attemptIds = new Set(samples.map((sample) => sample.attemptId));
  const base = {
    appId: first.appId,
    profileId: first.profileId,
    scenarioId: first.scenarioId,
    metricId: first.metricId,
    unit: first.unit,
    observationState,
    measuredSamples: samples.length,
    invalidSamples,
  } as const;
  if (observationState === "exact") {
    const values = samples.flatMap((sample) =>
      sample.observation.state === "exact" ? [sample.observation.value] : [],
    );
    const interval = bootstrapMedianInterval(values, { seed, iterations: 10_000 });
    return {
      ...base,
      rankable:
        invalidSamples === 0 &&
        samples.length === expectedSamples &&
        attemptIds.size === expectedSamples,
      median: median(values),
      confidenceInterval: { low: interval.low, high: interval.high },
    };
  }
  if (observationState === "bounded") {
    const observations = samples.flatMap((sample) =>
      sample.observation.state === "bounded" ? [sample.observation] : [],
    );
    const reason = observations.map((observation) => observation.reason).find(Boolean);
    return {
      ...base,
      rankable: false,
      lowerBound: Math.min(...observations.map((observation) => observation.lowerBound ?? 0)),
      upperBound: Math.max(...observations.map((observation) => observation.upperBound)),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const firstReason = samples.find(
    (sample) =>
      sample.observation.state === "unsupported" || sample.observation.state === "invalid",
  )?.observation;
  return {
    ...base,
    rankable: false,
    reason:
      firstReason?.state === "unsupported" || firstReason?.state === "invalid"
        ? firstReason.reason
        : "Observation states differed across measured runs.",
  };
}

export interface BuildBenchmarkReportInput {
  readonly frameworkVersion: string | number;
  readonly runId?: string;
  readonly runProfile: RunProfile;
  readonly seed?: number;
  readonly samples: ReadonlyArray<ReportSample>;
  readonly rawSamplesDigest?: string;
  readonly corpus?: AgentAppResultBundle["corpus"];
  readonly application?: ApplicationIdentity;
  readonly driver?: DriverIdentity;
  readonly environment?: EnvironmentDisclosure;
  readonly profiles?: ReadonlyArray<string>;
  readonly scenarios?: ReadonlyArray<string>;
  readonly measurementMethods?: ReadonlyArray<MeasurementMethodDisclosure>;
  readonly resourceTopology?: ResourceTopology;
  readonly limitations?: ReadonlyArray<string>;
}

export function buildBenchmarkReport(input: BuildBenchmarkReportInput): BenchmarkReport {
  const measured = input.samples.filter((sample) => sample.phase === "measured");
  const groups = new Map<string, Array<ReportSample>>();
  for (const sample of measured) {
    const existing = groups.get(summaryKey(sample)) ?? [];
    existing.push(sample);
    groups.set(summaryKey(sample), existing);
  }
  const expectedSamples = measuredRunCount(input.runProfile);
  const metrics = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, samples], index) =>
      summarizeMetric(samples, expectedSamples, (input.seed ?? 0) + index),
    );
  const failedAttempts = input.samples
    .filter((sample) => !sample.valid || sample.observation.state === "invalid")
    .map((sample) => ({
      attemptId: sample.attemptId,
      phase: sample.phase,
      profileId: sample.profileId,
      scenarioId: sample.scenarioId,
      metricId: sample.metricId,
      failures:
        sample.failures.length > 0
          ? sample.failures
          : [
              {
                code: "invalid-observation",
                message:
                  sample.observation.state === "invalid"
                    ? sample.observation.reason
                    : "The sample failed validity checks.",
              },
            ],
    }));
  const invalidMeasuredSamples = measured.filter(
    (sample) => !sample.valid || sample.observation.state === "invalid",
  ).length;
  const profiles = [...new Set(input.profiles ?? metrics.map((metric) => metric.profileId).sort())];
  const scenarios = [
    ...new Set(input.scenarios ?? metrics.map((metric) => metric.scenarioId).sort()),
  ];
  return {
    schemaVersion: 1,
    frameworkVersion: input.frameworkVersion,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    runProfile: input.runProfile,
    reportKind: input.runProfile === "publication" ? "publication" : "estimate",
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    // Deliberately `some`: a metric this platform cannot support must not
    // disqualify the metrics that were measured. Per-metric `rankable` carries
    // the row-level truth.
    rankable: invalidMeasuredSamples === 0 && metrics.some((metric) => metric.rankable),
    measuredSamples: measured.length,
    invalidMeasuredSamples,
    failedAttempts,
    rawSamplesDigest: input.rawSamplesDigest ?? sha256Digest(input.samples),
    metrics,
    ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
    ...(input.application === undefined ? {} : { application: input.application }),
    ...(input.driver === undefined ? {} : { driver: input.driver }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    profiles,
    scenarios,
    measurementMethods: [...(input.measurementMethods ?? [])].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
    ...(input.resourceTopology === undefined ? {} : { resourceTopology: input.resourceTopology }),
    limitations: [
      ...(input.runProfile === "publication"
        ? []
        : ["Smoke and quick profiles are non-publishable estimates."]),
      ...(input.limitations ?? []),
    ],
  };
}

function reportObservation(
  observation: AgentAppResultBundle["attempts"][number]["samples"][number]["observation"],
): ReportObservation {
  switch (observation.state) {
    case "exact":
      return { state: "exact", value: observation.value };
    case "bounded":
      return {
        state: "bounded",
        upperBound: observation.upperBound,
        reason: observation.reason,
      };
    case "unsupported":
      return { state: "unsupported", reason: observation.reason };
    case "invalid":
      return { state: "invalid", reason: observation.reason };
  }
}

function measurementMethodsFromBundle(
  bundle: AgentAppResultBundle,
): ReadonlyArray<MeasurementMethodDisclosure> {
  const methods = new Map<string, MeasurementMethodDisclosure>();
  for (const attempt of bundle.attempts) {
    for (const sample of attempt.samples) {
      for (const evidence of sample.evidence) {
        const method = {
          profileId: sample.profile,
          scenarioId: sample.scenario,
          metricId: sample.metric,
          clockOwner: evidence.clockOwner,
          clockDomain: evidence.clockDomain,
          observerMethod: evidence.observerMethod,
          resolutionMs: evidence.resolutionMs,
        } satisfies MeasurementMethodDisclosure;
        methods.set(canonicalJson(method), method);
      }
    }
  }
  return [...methods.values()];
}

/**
 * Builds presentation data from the versioned, app-neutral result contract.
 * Statistics are recomputed from raw attempts so the Markdown remains auditable
 * instead of trusting a separately supplied summary.
 */
export function buildBenchmarkReportFromResultBundle(
  bundle: AgentAppResultBundle,
  options: { readonly bootstrapSeed?: number } = {},
): BenchmarkReport {
  const samples = bundle.attempts.flatMap((attempt, runIndex) =>
    attempt.samples.map(
      (sample): ReportSample => ({
        attemptId: sample.attemptId,
        appId: bundle.application.name,
        profileId: sample.profile,
        scenarioId: sample.scenario,
        phase: attempt.measured ? "measured" : "warmup",
        runIndex,
        metricId: sample.metric,
        unit:
          sample.observation.state === "exact" || sample.observation.state === "bounded"
            ? sample.observation.unit
            : PRIMARY_METRIC_UNITS[sample.metric],
        observation: reportObservation(sample.observation),
        valid: sample.validity.status === "valid",
        failures:
          sample.validity.status === "invalid"
            ? sample.validity.failures.map((failure) => ({
                code: failure.code,
                message: failure.message,
                evidence: failure.evidence,
              }))
            : [],
      }),
    ),
  );
  const rawSamples = bundle.attempts.flatMap((attempt) => attempt.samples);
  const scenarios = [
    ...new Set(
      bundle.attempts.flatMap((attempt) => [
        ...attempt.samples.map((sample) => sample.scenario),
        ...attempt.diagnostics.map((diagnostic) => diagnostic.scenario),
      ]),
    ),
  ];
  return buildBenchmarkReport({
    frameworkVersion: bundle.frameworkVersion,
    runId: bundle.runId,
    runProfile: bundle.runProfile,
    ...(options.bootstrapSeed === undefined ? {} : { seed: options.bootstrapSeed }),
    samples,
    rawSamplesDigest: sha256Digest(rawSamples),
    corpus: bundle.corpus,
    application: bundle.application,
    driver: bundle.driver,
    environment: bundle.environment,
    profiles: bundle.profiles,
    scenarios,
    measurementMethods: measurementMethodsFromBundle(bundle),
    resourceTopology: bundle.resourceTopology,
    limitations: bundle.limitations,
  });
}

function formatValue(value: number | undefined): string {
  return value === undefined ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMetricValue(metric: MetricSummary): string {
  if (metric.observationState === "exact") return formatValue(metric.median);
  if (metric.observationState === "bounded") return `<${formatValue(metric.upperBound)}`;
  if (metric.observationState === "unsupported") return "N/A";
  return "Invalid";
}

function markdownCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return "—";
  return String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");
}

function metricDetails(metric: MetricSummary): string {
  if (metric.reason !== undefined) return metric.reason;
  if (metric.invalidSamples > 0) {
    return `${metric.invalidSamples} measured sample(s) failed validation.`;
  }
  if (!metric.rankable && metric.observationState === "exact") {
    return "The measured attempt count is incomplete for this run profile.";
  }
  return "—";
}

function identityLines(report: BenchmarkReport): ReadonlyArray<string> {
  if (report.application === undefined && report.driver === undefined) return [];
  const application = report.application;
  const driver = report.driver;
  return [
    "## Application and driver",
    "",
    "| Component | Name | Version | Build | Source commit | SHA-256 |",
    "|---|---|---|---|---|---|",
    ...(application === undefined
      ? []
      : [
          `| Application | ${markdownCell(application.name)} | ${markdownCell(application.version)} | ${markdownCell(application.build)} | ${markdownCell(application.sourceCommit)} | — |`,
        ]),
    ...(driver === undefined
      ? []
      : [
          `| Driver | ${markdownCell(driver.name)} | ${markdownCell(driver.version)} | — | ${markdownCell(driver.sourceCommit)} | \`${driver.digestSha256}\` |`,
        ]),
    "",
  ];
}

function environmentLines(environment: EnvironmentDisclosure | undefined): ReadonlyArray<string> {
  if (environment === undefined) return [];
  const fields: ReadonlyArray<readonly [string, string | number | boolean]> = [
    ["Captured at", environment.capturedAt],
    ["Operating system", environment.os],
    ["Architecture", environment.architecture],
    ["CPU", environment.cpuModel],
    ["Logical cores", environment.logicalCoreCount],
    [
      "Physical memory",
      `${(environment.physicalMemoryBytes / 1024 ** 3).toFixed(2)} GiB (${environment.physicalMemoryBytes} bytes)`,
    ],
    ["Display", `${environment.displayRefreshHz} Hz at ${environment.displayScale}x scale`],
    ["Window", `${environment.window.width} × ${environment.window.height}`],
    ["Power source", environment.powerSource],
    ["Thermal state", environment.thermalState],
    ["Color scheme", environment.colorScheme],
    ["Reduced motion", environment.reducedMotion],
    [
      "Launch flags",
      environment.launchFlags.length === 0 ? "none" : environment.launchFlags.join(" "),
    ],
  ];
  return [
    "## Environment",
    "",
    "| Field | Value |",
    "|---|---|",
    ...fields.map(([label, value]) => `| ${label} | ${markdownCell(value)} |`),
    "",
  ];
}

function measurementMethodLines(
  methods: ReadonlyArray<MeasurementMethodDisclosure>,
): ReadonlyArray<string> {
  if (methods.length === 0) return [];
  return [
    "## Measurement methods",
    "",
    "| Profile | Scenario | Metric | Clock owner/domain | Observer method | Resolution |",
    "|---|---|---|---|---|---:|",
    ...methods.map(
      (method) =>
        `| ${method.profileId} | ${method.scenarioId} | ${method.metricId} | ${markdownCell(`${method.clockOwner}/${method.clockDomain}`)} | ${markdownCell(method.observerMethod)} | ${formatValue(method.resolutionMs)} ms |`,
    ),
    "",
  ];
}

function failureEvidence(evidence: ReadonlyArray<ValidityCheckEvidence> | undefined): string {
  if (evidence === undefined || evidence.length === 0) return "—";
  return evidence
    .map((entry) => {
      const expected = entry.expectedSha256 ?? entry.expectedCount;
      const actual = entry.actualSha256 ?? entry.actualCount;
      const values =
        expected === undefined && actual === undefined
          ? ""
          : ` (expected ${expected ?? "—"}, actual ${actual ?? "—"})`;
      return `${entry.check}: ${entry.passed ? "passed" : "failed"}${values}`;
    })
    .join("; ");
}

function failureLines(report: BenchmarkReport): ReadonlyArray<string> {
  if (report.failedAttempts.length === 0) {
    return ["## Invalid and failed samples", "", "No measured samples failed validation.", ""];
  }
  return [
    "## Invalid and failed samples",
    "",
    "| Attempt | Phase | Profile | Scenario | Metric | Code | Failure | Evidence |",
    "|---|---|---|---|---|---|---|---|",
    ...report.failedAttempts.flatMap((attempt) =>
      attempt.failures.map(
        (failure) =>
          `| ${markdownCell(attempt.attemptId)} | ${attempt.phase} | ${markdownCell(attempt.profileId)} | ${markdownCell(attempt.scenarioId)} | ${markdownCell(attempt.metricId)} | ${markdownCell(failure.code)} | ${markdownCell(failure.message)} | ${markdownCell(failureEvidence(failure.evidence))} |`,
      ),
    ),
    "",
  ];
}

function topologyLines(topology: ResourceTopology | undefined): ReadonlyArray<string> {
  if (topology === undefined) return [];
  const rows = [
    ...topology.included.map((process) => ({ disposition: "included", process })),
    ...topology.excluded.map((process) => ({ disposition: "excluded", process })),
    ...topology.unattributed.map((process) => ({ disposition: "unattributed", process })),
  ];
  return [
    "## Process topology",
    "",
    `Included: ${topology.included.length}; excluded harness processes: ${topology.excluded.length}; unattributed: ${topology.unattributed.length}.`,
    "",
    ...(rows.length === 0
      ? ["No process identities were recorded."]
      : [
          "| Disposition | Owner | Category | PID | Start time (ms) |",
          "|---|---|---|---:|---:|",
          ...rows.map(
            ({ disposition, process }) =>
              `| ${disposition} | ${process.owner} | ${markdownCell(process.category)} | ${process.pid} | ${process.startTimeMs} |`,
          ),
        ]),
    "",
  ];
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const heading =
    report.reportKind === "publication"
      ? "Publication benchmark report"
      : "Benchmark report — non-publishable estimate";
  const rows = report.metrics.map((metric) => {
    const interval = metric.confidenceInterval
      ? `${formatValue(metric.confidenceInterval.low)}–${formatValue(metric.confidenceInterval.high)}`
      : "—";
    return `| ${markdownCell(metric.appId)} | ${markdownCell(metric.profileId)} | ${markdownCell(metric.scenarioId)} | ${markdownCell(metric.metricId)} | ${formatMetricValue(metric)} | ${markdownCell(metric.unit)} | ${interval} | ${metric.invalidSamples} | ${metric.rankable ? "yes" : "no"} | ${markdownCell(metricDetails(metric))} |`;
  });
  const limitations =
    report.limitations.length === 0
      ? ["- No additional framework limitations were recorded for this attempt."]
      : report.limitations.map((limitation) => `- ${markdownCell(limitation)}`);
  return [
    `# ${heading}`,
    "",
    `Framework version: ${report.frameworkVersion}  `,
    ...(report.runId === undefined ? [] : [`Run ID: \`${markdownCell(report.runId)}\`  `]),
    `Run profile: ${report.runProfile}  `,
    `Raw samples: \`${report.rawSamplesDigest}\`  `,
    `Rankable: ${report.rankable ? "yes" : "no"}`,
    "",
    ...(report.corpus === undefined
      ? []
      : [
          `Corpus: \`${markdownCell(report.corpus.corpusId)}\`  `,
          `Corpus SHA-256: \`${report.corpus.digestSha256}\``,
          "",
        ]),
    `Profiles: ${report.profiles.length === 0 ? "none recorded" : report.profiles.map((profile) => `\`${markdownCell(profile)}\``).join(", ")}  `,
    `Scenarios: ${report.scenarios.length === 0 ? "none recorded" : report.scenarios.map((scenario) => `\`${markdownCell(scenario)}\``).join(", ")}`,
    "",
    ...identityLines(report),
    ...environmentLines(report.environment),
    "## Independent metric results",
    "",
    "| App | Profile | Scenario | Metric | Median/bound | Unit | 95% bootstrap CI | Invalid | Rankable | Status/details |",
    "|---|---|---|---|---:|---|---:|---:|---|---|",
    ...rows,
    "",
    "Each row is an independent metric. Directional claims require a paired-difference interval that excludes zero and exceeds the disclosed resolution.",
    "",
    ...measurementMethodLines(report.measurementMethods),
    ...failureLines(report),
    ...topologyLines(report.resourceTopology),
    "## Limitations",
    "",
    ...limitations,
    "",
  ].join("\n");
}
