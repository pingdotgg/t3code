import * as Schema from "effect/Schema";

export const AGENT_APP_BENCHMARK_VERSION = 1 as const;
export const AGENT_APP_CORPUS_VERSION = 1 as const;
export const AGENT_APP_DRIVER_PROTOCOL_VERSION = 1 as const;
export const AGENT_APP_RESULT_VERSION = 1 as const;

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Identifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
);
const BoundedText = Schema.String.check(Schema.isMaxLength(4_096));
export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export type Sha256 = typeof Sha256.Type;

const nonEmptyArray = <A extends Schema.Top>(item: A) =>
  Schema.Array(item).check(Schema.isNonEmpty());

export const AgentAppProfileId = Schema.Literals(["workspace-core-v1", "resource-core-v1"]);
export type AgentAppProfileId = typeof AgentAppProfileId.Type;

export const AgentAppScenarioId = Schema.Literals([
  "app-cold-ready-v1",
  "work-item-cold-open-v1",
  "work-item-warm-switch-v1",
  "resource-sweep-v1",
  "resource-quiescence-v1",
]);
export type AgentAppScenarioId = typeof AgentAppScenarioId.Type;

export const PrimaryMetricId = Schema.Literals([
  "app.cold_ready_ms",
  "work_item.cold_open_ms",
  "work_item.warm_switch_p95_ms",
  "resource.peak_process_family_rss_mib",
  "resource.quiescent_cpu_p95_pct",
]);
export type PrimaryMetricId = typeof PrimaryMetricId.Type;

export const PrimaryMetricUnit = Schema.Literals(["ms", "percent", "MiB/s", "MiB"]);
export type PrimaryMetricUnit = typeof PrimaryMetricUnit.Type;

export const PRIMARY_METRIC_UNITS = {
  "app.cold_ready_ms": "ms",
  "work_item.cold_open_ms": "ms",
  "work_item.warm_switch_p95_ms": "ms",
  "resource.peak_process_family_rss_mib": "MiB",
  "resource.quiescent_cpu_p95_pct": "percent",
} as const satisfies Record<PrimaryMetricId, PrimaryMetricUnit>;

export const CorpusTextPart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type CorpusTextPart = typeof CorpusTextPart.Type;

export const CorpusMarkdownPart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("markdown"),
  markdown: Schema.String,
});
export type CorpusMarkdownPart = typeof CorpusMarkdownPart.Type;

export const CorpusCodePart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("code"),
  language: Identifier,
  code: Schema.String,
});
export type CorpusCodePart = typeof CorpusCodePart.Type;

export const CorpusTablePart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("table"),
  headers: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.String)),
});
export type CorpusTablePart = typeof CorpusTablePart.Type;

export const CorpusDiffPart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("diff"),
  path: Identifier,
  oldText: Schema.String,
  newText: Schema.String,
  patch: Schema.String,
});
export type CorpusDiffPart = typeof CorpusDiffPart.Type;

export const CorpusReasoningPart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
});
export type CorpusReasoningPart = typeof CorpusReasoningPart.Type;

export const CorpusAttachmentPart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("attachment"),
  name: Identifier,
  mediaType: Identifier,
  sizeBytes: NonNegativeInt,
  sha256: Sha256,
});
export type CorpusAttachmentPart = typeof CorpusAttachmentPart.Type;

export const CorpusToolPart = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  type: Schema.Literal("tool"),
  callId: Identifier,
  toolName: Identifier,
  state: Schema.Literals(["pending", "running", "completed", "error"]),
  inputJson: Schema.String,
  outputText: Schema.String,
});
export type CorpusToolPart = typeof CorpusToolPart.Type;

export const CorpusPart = Schema.Union([
  CorpusTextPart,
  CorpusMarkdownPart,
  CorpusCodePart,
  CorpusTablePart,
  CorpusDiffPart,
  CorpusReasoningPart,
  CorpusAttachmentPart,
  CorpusToolPart,
]);
export type CorpusPart = typeof CorpusPart.Type;

export const CorpusMessage = Schema.Struct({
  id: Identifier,
  order: NonNegativeInt,
  role: Schema.Literals(["system", "user", "assistant"]),
  parts: Schema.Array(CorpusPart),
});
export type CorpusMessage = typeof CorpusMessage.Type;

export const CorpusTurn = Schema.Struct({
  id: Identifier,
  index: NonNegativeInt,
  anchor: Schema.optionalKey(Schema.Literals(["first", "middle", "last"])),
  messages: Schema.Array(CorpusMessage),
});
export type CorpusTurn = typeof CorpusTurn.Type;

export const CorpusMessagePartRevisionEvent = Schema.Struct({
  id: Identifier,
  sequence: NonNegativeInt,
  atMs: NonNegativeInt,
  type: Schema.Literal("message-part-revision"),
  messageId: Identifier,
  partId: Identifier,
  revision: PositiveInt,
  content: Schema.String,
});

export const CorpusToolLifecycleEvent = Schema.Struct({
  id: Identifier,
  sequence: NonNegativeInt,
  atMs: NonNegativeInt,
  type: Schema.Literal("tool-lifecycle"),
  callId: Identifier,
  toolName: Identifier,
  state: Schema.Literals(["pending", "running", "completed", "error"]),
  inputJson: Schema.optionalKey(Schema.String),
  outputText: Schema.optionalKey(Schema.String),
});

export const CorpusStreamCompleteEvent = Schema.Struct({
  id: Identifier,
  sequence: NonNegativeInt,
  atMs: NonNegativeInt,
  type: Schema.Literal("stream-complete"),
  turnId: Identifier,
});

export const CorpusLifecycleEvent = Schema.Union([
  CorpusMessagePartRevisionEvent,
  CorpusToolLifecycleEvent,
  CorpusStreamCompleteEvent,
]);
export type CorpusLifecycleEvent = typeof CorpusLifecycleEvent.Type;

export const CorpusTerminalChunk = Schema.Struct({
  sequence: NonNegativeInt,
  atMs: NonNegativeInt,
  bytesBase64: Schema.String,
});
export type CorpusTerminalChunk = typeof CorpusTerminalChunk.Type;

export const CorpusTerminalStream = Schema.Struct({
  id: Identifier,
  columns: PositiveInt,
  rows: PositiveInt,
  chunks: Schema.Array(CorpusTerminalChunk),
  inputSentinels: Schema.Array(Schema.String),
  expectedBytes: NonNegativeInt,
  expectedSha256: Sha256,
});
export type CorpusTerminalStream = typeof CorpusTerminalStream.Type;

export const CorpusSession = Schema.Struct({
  id: Identifier,
  title: Schema.String,
  order: NonNegativeInt,
  /**
   * Workspace/project assignment carried IN the corpus so every driver
   * materializes the same cross-workspace layout. Absent on corpora that
   * predate multi-workspace scale (single-workspace materialization).
   */
  workspaceId: Schema.optionalKey(Identifier),
  turns: Schema.Array(CorpusTurn),
  events: Schema.Array(CorpusLifecycleEvent),
  terminalStreams: Schema.Array(CorpusTerminalStream),
});
export type CorpusSession = typeof CorpusSession.Type;

export const AgentAppCorpusCounts = Schema.Struct({
  sessions: NonNegativeInt,
  turns: NonNegativeInt,
  messages: NonNegativeInt,
  parts: NonNegativeInt,
  textParts: NonNegativeInt,
  markdownParts: NonNegativeInt,
  codeParts: NonNegativeInt,
  tableParts: NonNegativeInt,
  diffParts: NonNegativeInt,
  toolParts: NonNegativeInt,
  reasoningParts: NonNegativeInt,
  attachments: NonNegativeInt,
  lifecycleEvents: NonNegativeInt,
  terminalStreams: NonNegativeInt,
  terminalBytes: NonNegativeInt,
  renderableBytes: NonNegativeInt,
});
export type AgentAppCorpusCounts = typeof AgentAppCorpusCounts.Type;

export const AgentAppCorpusHashes = Schema.Struct({
  corpusSha256: Sha256,
  semanticSha256: Sha256,
  terminalSha256: Sha256,
});
export type AgentAppCorpusHashes = typeof AgentAppCorpusHashes.Type;

export const AgentAppCorpusManifest = Schema.Struct({
  counts: AgentAppCorpusCounts,
  hashes: AgentAppCorpusHashes,
});
export type AgentAppCorpusManifest = typeof AgentAppCorpusManifest.Type;

export const AgentAppCorpus = Schema.Struct({
  schemaVersion: Schema.Literal(AGENT_APP_CORPUS_VERSION),
  kind: Schema.Literal("agent-app-corpus"),
  corpusId: Identifier,
  source: Schema.Literals(["generated-public", "opencode-local"]),
  seed: Identifier,
  sessions: Schema.Array(CorpusSession),
  manifest: AgentAppCorpusManifest,
});
export type AgentAppCorpus = typeof AgentAppCorpus.Type;

export const AgentAppCorpusGeneratorConfig = Schema.Struct({
  schemaVersion: Schema.Literal(AGENT_APP_CORPUS_VERSION),
  corpusId: Identifier,
  seed: Identifier,
  scale: Schema.Struct({
    sessionCount: PositiveInt,
    turnsPerSession: PositiveInt,
    // Mixed-distribution tail: the LAST `heavySessionCount` sessions carry
    // `heavyTurnsPerSession` turns instead of `turnsPerSession`. Real
    // workspaces are a few enormous threads among many ordinary ones, and the
    // uniform corpus never exercises the lazy-hydration / virtualization
    // regime where "open an old heavy session" actually hurts. Optional and
    // additive: absent fields generate the exact corpus (and digest) produced
    // before they existed.
    heavySessionCount: Schema.optionalKey(NonNegativeInt),
    heavyTurnsPerSession: Schema.optionalKey(PositiveInt),
    /** Payload multiplier for heavy-tail turns (diff/tool/shell parts). */
    heavyPartWeight: Schema.optionalKey(PositiveInt),
    // Graded ramp: session i's turn count interpolates GEOMETRICALLY from
    // `turnsPerSession` (index 0) to `gradedTurnsTo` (last index), and its
    // part weight linearly from 1 to `gradedPartWeightTo`. One corpus then
    // spans light->heavy so per-session samples read as a trend over session
    // weight instead of two disconnected corpora. Overrides the heavy-tail
    // fields when present. Optional and additive: absent fields generate the
    // exact corpus (and digest) produced before they existed.
    gradedTurnsTo: Schema.optionalKey(PositiveInt),
    gradedPartWeightTo: Schema.optionalKey(PositiveInt),
    /**
     * Distribute sessions round-robin across this many workspaces/projects
     * (session i -> workspace i % workspaceCount), so warm switching
     * naturally crosses workspace boundaries. Absent = one workspace.
     */
    workspaceCount: Schema.optionalKey(PositiveInt),
    terminalChunkCount: PositiveInt,
    terminalChunkBytes: PositiveInt,
  }),
  expectedManifest: AgentAppCorpusManifest,
});
export type AgentAppCorpusGeneratorConfig = typeof AgentAppCorpusGeneratorConfig.Type;

export const CoverageEvidence = Schema.Struct({
  profile: AgentAppProfileId,
  corpusDigestSha256: Sha256,
  counts: AgentAppCorpusCounts,
  semanticSha256: Sha256,
  passed: Schema.Boolean,
  unsupportedShapes: Schema.Array(Identifier),
});
export type CoverageEvidence = typeof CoverageEvidence.Type;

export const ClockEvidence = Schema.Struct({
  sequence: NonNegativeInt,
  name: Identifier,
  clockOwner: Identifier,
  clockDomain: Identifier,
  resolutionMs: NonNegative,
  observerMethod: BoundedText.check(Schema.isNonEmpty()),
  startTimestamp: NonNegative,
  endTimestamp: NonNegative,
});
export type ClockEvidence = typeof ClockEvidence.Type;

export const ValidityCheckEvidence = Schema.Struct({
  check: Identifier,
  expectedSha256: Schema.optionalKey(Sha256),
  actualSha256: Schema.optionalKey(Sha256),
  expectedCount: Schema.optionalKey(NonNegativeInt),
  actualCount: Schema.optionalKey(NonNegativeInt),
  passed: Schema.Boolean,
});
export type ValidityCheckEvidence = typeof ValidityCheckEvidence.Type;

export const ValidityFailure = Schema.Struct({
  code: Identifier,
  message: BoundedText.check(Schema.isNonEmpty()),
  evidence: Schema.Array(ValidityCheckEvidence),
});
export type ValidityFailure = typeof ValidityFailure.Type;

export const SampleValidity = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("valid"),
    evidence: nonEmptyArray(ValidityCheckEvidence),
  }),
  Schema.Struct({
    status: Schema.Literal("invalid"),
    evidence: Schema.Array(ValidityCheckEvidence),
    failures: nonEmptyArray(ValidityFailure),
  }),
]);
export type SampleValidity = typeof SampleValidity.Type;

export const MetricObservation = Schema.Union([
  Schema.Struct({ state: Schema.Literal("exact"), value: NonNegative, unit: PrimaryMetricUnit }),
  Schema.Struct({
    state: Schema.Literal("bounded"),
    upperBound: NonNegative,
    unit: PrimaryMetricUnit,
    reason: Identifier,
  }),
  Schema.Struct({
    state: Schema.Literal("unsupported"),
    reason: BoundedText.check(Schema.isNonEmpty()),
  }),
  Schema.Struct({
    state: Schema.Literal("invalid"),
    reason: BoundedText.check(Schema.isNonEmpty()),
  }),
]);
export type MetricObservation = typeof MetricObservation.Type;

export const RawMetricSample = Schema.Struct({
  schemaVersion: Schema.Literal(AGENT_APP_RESULT_VERSION),
  sampleId: Identifier,
  attemptId: Identifier,
  profile: AgentAppProfileId,
  scenario: AgentAppScenarioId,
  metric: PrimaryMetricId,
  observation: MetricObservation,
  evidence: nonEmptyArray(ClockEvidence),
  validity: SampleValidity,
});
export type RawMetricSample = typeof RawMetricSample.Type;

export const DiagnosticMetricName = Schema.String.check(
  Schema.isPattern(/^diagnostic\.[a-z0-9_.-]+$/u),
);
export type DiagnosticMetricName = typeof DiagnosticMetricName.Type;

export const DiagnosticSample = Schema.Struct({
  schemaVersion: Schema.Literal(AGENT_APP_RESULT_VERSION),
  sampleId: Identifier,
  attemptId: Identifier,
  profile: AgentAppProfileId,
  scenario: AgentAppScenarioId,
  name: DiagnosticMetricName,
  value: Schema.Union([Schema.Number, Schema.String, Schema.Boolean]),
  unit: Schema.optionalKey(Identifier),
  evidence: Schema.Array(ClockEvidence),
});
export type DiagnosticSample = typeof DiagnosticSample.Type;

export const ApplicationIdentity = Schema.Struct({
  name: Identifier,
  version: Identifier,
  build: Schema.Literals(["release", "production-equivalent"]),
  sourceCommit: Schema.optionalKey(Identifier),
});
export type ApplicationIdentity = typeof ApplicationIdentity.Type;

export const DriverIdentity = Schema.Struct({
  name: Identifier,
  version: Identifier,
  digestSha256: Sha256,
  sourceCommit: Schema.optionalKey(Identifier),
});
export type DriverIdentity = typeof DriverIdentity.Type;

export const DriverCapabilities = Schema.Struct({
  profiles: Schema.Array(AgentAppProfileId),
  scenarios: Schema.Array(AgentAppScenarioId),
  metrics: Schema.Array(PrimaryMetricId),
  readinessDetection: BoundedText.check(Schema.isNonEmpty()),
  paintDetection: BoundedText.check(Schema.isNonEmpty()),
  requiredPreparation: Schema.Array(BoundedText),
});
export type DriverCapabilities = typeof DriverCapabilities.Type;

export const DriverHelloResult = Schema.Struct({
  protocolVersion: Schema.Literal(AGENT_APP_DRIVER_PROTOCOL_VERSION),
  application: ApplicationIdentity,
  driver: DriverIdentity,
  capabilities: DriverCapabilities,
});
export type DriverHelloResult = typeof DriverHelloResult.Type;

export const OwnedProcess = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  owner: Schema.Literals(["application", "harness"]),
  category: Identifier,
});
export type OwnedProcess = typeof OwnedProcess.Type;

export const ResourceTopology = Schema.Struct({
  included: Schema.Array(OwnedProcess),
  excluded: Schema.Array(OwnedProcess),
  unattributed: Schema.Array(OwnedProcess),
});
export type ResourceTopology = typeof ResourceTopology.Type;

const DriverMethod = Schema.Literals(["hello", "prepare", "launch", "run-scenario", "shutdown"]);
export type DriverMethod = typeof DriverMethod.Type;

const DriverRequestBase = {
  protocolVersion: Schema.Literal(AGENT_APP_DRIVER_PROTOCOL_VERSION),
  kind: Schema.Literal("request"),
  correlationId: Identifier,
};

export const DriverRequest = Schema.Union([
  Schema.Struct({
    ...DriverRequestBase,
    method: Schema.Literal("hello"),
    params: Schema.Struct({ frameworkVersion: Schema.Literal(AGENT_APP_BENCHMARK_VERSION) }),
  }),
  Schema.Struct({
    ...DriverRequestBase,
    method: Schema.Literal("prepare"),
    params: Schema.Struct({
      corpusPath: Identifier,
      corpusDigestSha256: Sha256,
      runDirectory: Identifier,
      profiles: nonEmptyArray(AgentAppProfileId),
    }),
  }),
  Schema.Struct({
    ...DriverRequestBase,
    method: Schema.Literal("launch"),
    params: Schema.Struct({ isolatedProfilePath: Identifier }),
  }),
  Schema.Struct({
    ...DriverRequestBase,
    method: Schema.Literal("run-scenario"),
    params: Schema.Struct({
      attemptId: Identifier,
      profile: AgentAppProfileId,
      scenario: AgentAppScenarioId,
      seed: Identifier,
    }),
  }),
  Schema.Struct({
    ...DriverRequestBase,
    method: Schema.Literal("shutdown"),
    params: Schema.Struct({ reason: BoundedText }),
  }),
]);
export type DriverRequest = typeof DriverRequest.Type;

const responseBase = {
  protocolVersion: Schema.Literal(AGENT_APP_DRIVER_PROTOCOL_VERSION),
  kind: Schema.Literal("response"),
  correlationId: Identifier,
};

const DriverError = Schema.Struct({
  code: Identifier,
  message: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  retriable: Schema.Boolean,
});

const failedResponse = Schema.Struct({
  ...responseBase,
  method: DriverMethod,
  ok: Schema.Literal(false),
  error: DriverError,
});

export const DriverResponse = Schema.Union([
  failedResponse,
  Schema.Struct({
    ...responseBase,
    method: Schema.Literal("hello"),
    ok: Schema.Literal(true),
    result: DriverHelloResult,
  }),
  Schema.Struct({
    ...responseBase,
    method: Schema.Literal("prepare"),
    ok: Schema.Literal(true),
    result: Schema.Struct({ coverage: Schema.Array(CoverageEvidence) }),
  }),
  Schema.Struct({
    ...responseBase,
    method: Schema.Literal("launch"),
    ok: Schema.Literal(true),
    result: Schema.Struct({
      processes: nonEmptyArray(OwnedProcess),
      automationReady: Schema.Boolean,
      readinessEvidence: BoundedText.check(Schema.isNonEmpty()),
    }),
  }),
  Schema.Struct({
    ...responseBase,
    method: Schema.Literal("run-scenario"),
    ok: Schema.Literal(true),
    result: Schema.Struct({ samples: nonEmptyArray(RawMetricSample) }),
  }),
  Schema.Struct({
    ...responseBase,
    method: Schema.Literal("shutdown"),
    ok: Schema.Literal(true),
    result: Schema.Struct({
      terminated: Schema.Array(OwnedProcess),
      survivors: Schema.Array(OwnedProcess),
    }),
  }),
]);
export type DriverResponse = typeof DriverResponse.Type;

export const DriverMessage = Schema.Union([DriverRequest, DriverResponse]);
export type DriverMessage = typeof DriverMessage.Type;

export const EnvironmentDisclosure = Schema.Struct({
  capturedAt: Identifier,
  os: Identifier,
  architecture: Identifier,
  cpuModel: Identifier,
  logicalCoreCount: PositiveInt,
  physicalMemoryBytes: PositiveInt,
  displayRefreshHz: Schema.Number.check(Schema.isGreaterThan(0)),
  displayScale: Schema.Number.check(Schema.isGreaterThan(0)),
  powerSource: Identifier,
  thermalState: Identifier,
  window: Schema.Struct({ width: PositiveInt, height: PositiveInt }),
  colorScheme: Schema.Literals(["light", "dark"]),
  reducedMotion: Schema.Boolean,
  launchFlags: Schema.Array(Schema.String),
});
export type EnvironmentDisclosure = typeof EnvironmentDisclosure.Type;

export const MetricStatistic = Schema.Struct({
  profile: AgentAppProfileId,
  metric: PrimaryMetricId,
  unit: PrimaryMetricUnit,
  median: NonNegative,
  confidenceInterval95: Schema.Struct({ lower: NonNegative, upper: NonNegative }),
  measuredCount: NonNegativeInt,
  invalidCount: NonNegativeInt,
});
export type MetricStatistic = typeof MetricStatistic.Type;

export const AgentAppResultBundle = Schema.Struct({
  schemaVersion: Schema.Literal(AGENT_APP_RESULT_VERSION),
  frameworkVersion: Identifier,
  runId: Identifier,
  corpus: Schema.Struct({ corpusId: Identifier, digestSha256: Sha256 }),
  runProfile: Schema.Literals(["smoke", "quick", "publication"]),
  application: ApplicationIdentity,
  driver: DriverIdentity,
  profiles: nonEmptyArray(AgentAppProfileId),
  environment: EnvironmentDisclosure,
  resourceTopology: ResourceTopology,
  attempts: Schema.Array(
    Schema.Struct({
      attemptId: Identifier,
      measured: Schema.Boolean,
      samples: Schema.Array(RawMetricSample),
      diagnostics: Schema.Array(DiagnosticSample),
    }),
  ),
  statistics: Schema.Array(MetricStatistic),
  limitations: Schema.Array(BoundedText),
});
export type AgentAppResultBundle = typeof AgentAppResultBundle.Type;

const decodeCorpusSchema = Schema.decodeUnknownSync(AgentAppCorpus);
const decodeConfigSchema = Schema.decodeUnknownSync(AgentAppCorpusGeneratorConfig);
const decodeMessageSchema = Schema.decodeUnknownSync(DriverMessage);
const decodeSampleSchema = Schema.decodeUnknownSync(RawMetricSample);
const decodeResultSchema = Schema.decodeUnknownSync(AgentAppResultBundle);

export const decodeAgentAppCorpus = (input: unknown): AgentAppCorpus => decodeCorpusSchema(input);
export const decodeCorpusGeneratorConfig = (input: unknown): AgentAppCorpusGeneratorConfig =>
  decodeConfigSchema(input);

function assertMetricUnit(sample: RawMetricSample): void {
  if (sample.observation.state === "unsupported" || sample.observation.state === "invalid") return;
  const expected = PRIMARY_METRIC_UNITS[sample.metric];
  if (sample.observation.unit !== expected) {
    throw new Error(
      `Metric ${sample.metric} requires ${expected}; received ${sample.observation.unit}.`,
    );
  }
}

function assertMonotonicEvidence(sample: RawMetricSample): void {
  let previousSequence = -1;
  const clockEnds = new Map<string, number>();
  for (const evidence of sample.evidence) {
    if (evidence.sequence <= previousSequence) {
      throw new Error(`Metric ${sample.metric} evidence sequence must be strictly monotonic.`);
    }
    if (evidence.endTimestamp < evidence.startTimestamp) {
      throw new Error(`Metric ${sample.metric} evidence timestamps must be monotonic.`);
    }
    const clock = `${evidence.clockOwner}\0${evidence.clockDomain}`;
    const previousEnd = clockEnds.get(clock);
    if (previousEnd !== undefined && evidence.startTimestamp < previousEnd) {
      throw new Error(`Metric ${sample.metric} evidence must be monotonic within each clock.`);
    }
    previousSequence = evidence.sequence;
    clockEnds.set(clock, evidence.endTimestamp);
  }
}

function assertValidityEvidence(sample: RawMetricSample): void {
  if (
    sample.validity.status === "valid" &&
    sample.validity.evidence.some((evidence) => !evidence.passed)
  ) {
    throw new Error(`Metric ${sample.metric} is valid but contains failed validity evidence.`);
  }
  if (sample.observation.state === "invalid" && sample.validity.status !== "invalid") {
    throw new Error(`Metric ${sample.metric} has an invalid observation without invalid validity.`);
  }
}

export function decodeRawMetricSample(input: unknown): RawMetricSample {
  const sample = decodeSampleSchema(input);
  assertMetricUnit(sample);
  assertMonotonicEvidence(sample);
  assertValidityEvidence(sample);
  return sample;
}

export function decodeDriverMessage(input: unknown): DriverMessage {
  const message = decodeMessageSchema(input);
  if (message.kind === "response" && message.ok && message.method === "run-scenario") {
    for (const sample of message.result.samples) {
      assertMetricUnit(sample);
      assertMonotonicEvidence(sample);
      assertValidityEvidence(sample);
    }
  }
  return message;
}

export function decodeResultBundle(input: unknown): AgentAppResultBundle {
  const result = decodeResultSchema(input);
  for (const attempt of result.attempts) {
    for (const sample of attempt.samples) {
      assertMetricUnit(sample);
      assertMonotonicEvidence(sample);
      assertValidityEvidence(sample);
    }
  }
  for (const statistic of result.statistics) {
    if (statistic.unit !== PRIMARY_METRIC_UNITS[statistic.metric]) {
      throw new Error(`Statistic ${statistic.metric} has the wrong unit.`);
    }
    if (statistic.confidenceInterval95.lower > statistic.confidenceInterval95.upper) {
      throw new Error(`Statistic ${statistic.metric} has a reversed confidence interval.`);
    }
  }
  return result;
}

export function validateDriverTranscript(
  input: ReadonlyArray<unknown>,
): ReadonlyArray<DriverMessage> {
  const messages = input.map(decodeDriverMessage);
  const requests = new Map<string, DriverRequest>();
  const responses = new Set<string>();
  for (const message of messages) {
    if (message.kind === "request") {
      if (requests.has(message.correlationId)) {
        throw new Error(
          `Driver transcript contains duplicate correlation ID ${message.correlationId}.`,
        );
      }
      requests.set(message.correlationId, message);
      continue;
    }
    if (responses.has(message.correlationId)) {
      throw new Error(
        `Driver transcript contains duplicate response for ${message.correlationId}.`,
      );
    }
    const request = requests.get(message.correlationId);
    if (!request) throw new Error(`Driver response ${message.correlationId} has no request.`);
    if (request.method !== message.method) {
      throw new Error(
        `Driver response ${message.correlationId} does not match its request method.`,
      );
    }
    responses.add(message.correlationId);
  }
  return messages;
}
