// @effect-diagnostics nodeBuiltinImport:off - T3 owns a local durable compatibility store at the Node filesystem boundary.
// @effect-diagnostics globalDate:off - persisted compatibility records use Unix timestamps and ISO strings.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardAutomationKind,
  AgentDashboardCollectorState,
  AgentDashboardExternalAction,
  AgentDashboardFinding,
  AgentDashboardFindingActionability,
  AgentDashboardFindingConfidence,
  AgentDashboardFindingKind,
  AgentDashboardFindingSeverity,
  AgentDashboardFindingType,
  AgentDashboardFeedAction,
  AgentDashboardFeedCard,
  AgentDashboardFeedOrigin,
  AgentDashboardDispositionActionInput,
  AgentDashboardLinkFindingThreadInput,
  AgentDashboardRepositoryCoverage,
  AgentDashboardRepositoryPolicy,
  AgentDashboardRepositoryPolicyInput,
  AgentDashboardResearchWatchItemInput,
  AgentDashboardResearchFinding,
  AgentDashboardReviewSuggestion,
} from "@t3tools/contracts";
import {
  AgentDashboardCollectorState as AgentDashboardCollectorStateSchema,
  AgentDashboardExternalAction as AgentDashboardExternalActionSchema,
  AgentDashboardFinding as AgentDashboardFindingSchema,
  AgentDashboardRepositoryCoverage as AgentDashboardRepositoryCoverageSchema,
  AgentDashboardRepositoryPolicy as AgentDashboardRepositoryPolicySchema,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";

const MAX_FEED_CARDS = 200;
const AGENT_FEED_RETENTION_SECONDS = 2 * 24 * 60 * 60;
const MAX_RESEARCH_FINDINGS = 500;
const MAX_TEXT = 8_000;
const MAX_FEED_IMAGE_BYTES = 8 * 1024 * 1024;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[0-9]+$/;
const decodeAgentDashboardFinding = Schema.decodeUnknownSync(AgentDashboardFindingSchema);
const decodeAgentDashboardRepositoryPolicy = Schema.decodeUnknownSync(
  AgentDashboardRepositoryPolicySchema,
);
const decodeAgentDashboardRepositoryCoverage = Schema.decodeUnknownSync(
  AgentDashboardRepositoryCoverageSchema,
);
const decodeAgentDashboardExternalAction = Schema.decodeUnknownSync(
  AgentDashboardExternalActionSchema,
);
const decodeAgentDashboardCollectorState = Schema.decodeUnknownSync(
  AgentDashboardCollectorStateSchema,
);
const FEED_IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

type JsonObject = Record<string, unknown>;

export class AgentDashboardStoreError extends Schema.TaggedError<AgentDashboardStoreError>()(
  "AgentDashboardStoreError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const mergeRepositoryPolicyInput = (
  input: AgentDashboardRepositoryPolicyInput,
  existing: AgentDashboardRepositoryPolicy | undefined,
): AgentDashboardRepositoryPolicy => ({
  repository: input.repository,
  enabled: input.enabled ?? existing?.enabled ?? true,
  ...(input.enabledAutomations !== undefined
    ? { enabledAutomations: input.enabledAutomations }
    : existing?.enabledAutomations !== undefined
      ? { enabledAutomations: existing.enabledAutomations }
      : {}),
  ...(input.disabledAutomations !== undefined
    ? { disabledAutomations: input.disabledAutomations }
    : existing?.disabledAutomations !== undefined
      ? { disabledAutomations: existing.disabledAutomations }
      : {}),
  ...(input.productContextPath !== undefined
    ? { productContextPath: input.productContextPath }
    : existing?.productContextPath !== undefined
      ? { productContextPath: existing.productContextPath }
      : {}),
  ...(input.productContextConfirmedAt !== undefined
    ? { productContextConfirmedAt: input.productContextConfirmedAt }
    : existing?.productContextConfirmedAt !== undefined
      ? { productContextConfirmedAt: existing.productContextConfirmedAt }
      : {}),
  cadenceMinutes: input.cadenceMinutes ?? existing?.cadenceMinutes ?? 120,
  priority: input.priority ?? existing?.priority ?? 0,
  riskTier: input.riskTier ?? existing?.riskTier ?? "low",
  branch: input.branch !== undefined ? input.branch : (existing?.branch ?? null),
  owner: input.owner !== undefined ? input.owner : (existing?.owner ?? null),
  enabledChecks: input.enabledChecks ?? existing?.enabledChecks ?? ["repository-review"],
  model: input.model !== undefined ? input.model : (existing?.model ?? null),
  budgetMinutes:
    input.budgetMinutes !== undefined ? input.budgetMinutes : (existing?.budgetMinutes ?? null),
  maxConcurrentRuns: input.maxConcurrentRuns ?? existing?.maxConcurrentRuns ?? 1,
  exclusions: input.exclusions ?? existing?.exclusions ?? [],
  updatedAt: input.updatedAt,
});

export const repositoryAutomationsEnabled = (
  policies: ReadonlyArray<AgentDashboardRepositoryPolicy>,
  projectId: ProjectId,
  automationKind?: AgentDashboardAutomationKind,
): boolean => {
  const policy = policies.find(
    (candidate) => String(candidate.repository.projectId) === String(projectId),
  );
  if (policy?.enabled === false) return false;
  if (automationKind !== undefined && policy?.disabledAutomations !== undefined) {
    return !policy.disabledAutomations.includes(automationKind);
  }
  if (automationKind === undefined || policy?.enabledAutomations === undefined) return true;
  return (
    policy.enabledAutomations.includes(automationKind) ||
    automationKind === "inactive-worktree-cleanup" ||
    automationKind === "product-opportunity-discovery" ||
    automationKind === "decision-follow-up"
  );
};

export interface AgentDashboardFeedImage {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface AgentDashboardReviewFindingInput {
  readonly title: string;
  readonly type: AgentDashboardFindingType;
  readonly category: string;
  readonly summary: string;
  readonly impact: string;
  readonly confidence: string;
  readonly evidence: ReadonlyArray<string>;
  readonly nextStep: string;
  readonly targets?: AgentDashboardFindingActionability["targets"] | undefined;
  readonly validationPlan?: ReadonlyArray<string> | undefined;
  readonly sources?: AgentDashboardFindingActionability["sources"] | undefined;
  readonly automationRisk?: AgentDashboardFindingActionability["riskTier"] | undefined;
  readonly estimatedEffort?: AgentDashboardFindingActionability["estimatedEffort"] | undefined;
  readonly qualificationReason?: string | null | undefined;
  readonly githubIssueTitle: string;
  readonly githubIssueBody: string;
  readonly markdown?: string | undefined;
}

export interface AgentDashboardReviewIngestInput {
  readonly jobId: string;
  readonly runId?: string | null | undefined;
  readonly projectId?: string | null | undefined;
  readonly threadId?: string | null | undefined;
  readonly repository: {
    readonly name: string;
    readonly path: string;
    readonly githubRepo?: string | null | undefined;
  };
  readonly findings: ReadonlyArray<AgentDashboardReviewFindingInput>;
}

export type AgentDashboardFindingQualificationInput =
  | {
      readonly id: string;
      readonly outcome: "ready" | "needs-research";
      readonly proposal: string;
      readonly expectedValue: string;
      readonly targets: AgentDashboardFindingActionability["targets"];
      readonly validationPlan: ReadonlyArray<string>;
      readonly sources: AgentDashboardFindingActionability["sources"];
      readonly riskTier: AgentDashboardFindingActionability["riskTier"];
      readonly estimatedEffort: AgentDashboardFindingActionability["estimatedEffort"];
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly outcome: "dismiss";
      readonly reason: string;
    };

export interface AgentDashboardCanonicalFindingInput {
  readonly type?: AgentDashboardFindingType | undefined;
  readonly kind: AgentDashboardFindingKind;
  readonly title: string;
  readonly summary: string;
  readonly severity?: AgentDashboardFindingSeverity | undefined;
  readonly confidence?: AgentDashboardFindingConfidence | undefined;
  readonly category?: string | null | undefined;
  readonly evidence?: ReadonlyArray<string> | undefined;
  readonly repository: { readonly projectId: string };
  readonly repositoryPath?: string | null | undefined;
  readonly source: string;
  readonly sourceAt?: string | null | undefined;
  readonly collectedAt?: string | undefined;
  readonly runId?: string | null | undefined;
  readonly threadId?: string | null | undefined;
  readonly externalIssueUrl?: string | null | undefined;
  readonly actionability?: AgentDashboardFinding["actionability"] | undefined;
}

export const buildCanonicalGithubIssueDraft = (
  finding: AgentDashboardFinding,
): { readonly title: string; readonly body: string } => {
  const actionability = finding.actionability;
  const sections = [
    "## Finding",
    finding.summary,
    ...(finding.evidence.length > 0
      ? ["", "## Evidence", ...finding.evidence.map((item) => `- ${item}`)]
      : []),
    ...(actionability
      ? [
          "",
          "## Proposed work",
          actionability.proposal,
          "",
          "## Expected value",
          actionability.expectedValue,
          ...(actionability.targets.length > 0
            ? [
                "",
                "## Code targets",
                ...actionability.targets.map(
                  (target) =>
                    `- \`${target.path}\`${target.symbol ? ` (${target.symbol})` : ""}: ${target.evidence}`,
                ),
              ]
            : []),
          ...(actionability.validationPlan.length > 0
            ? ["", "## Validation", ...actionability.validationPlan.map((item) => `- ${item}`)]
            : []),
        ]
      : []),
    "",
    "## Source",
    `${finding.provenance.source}${finding.provenance.sourceAt ? ` (${finding.provenance.sourceAt})` : ""}`,
    ...(actionability?.sources.length
      ? actionability.sources.map((source) => `- [${source.title}](${source.url}) (${source.kind})`)
      : []),
  ];
  return { title: finding.title, body: sections.join("\n") };
};

export type AgentDashboardStoreMutationOutcome = "applied" | "noop" | "not-found";

export interface AgentDashboardStaleFindingResolutionInput extends AgentDashboardLinkFindingThreadInput {
  readonly reason: string;
}

export const isContinuousImprovementFindingReservation = (
  finding: AgentDashboardFinding,
): boolean =>
  finding.thread !== null &&
  finding.disposition.state === "in-progress" &&
  finding.disposition.actor === "continuous-improvement" &&
  finding.disposition.note === "Reserved by Continuous Improvement Mode." &&
  finding.disposition.snoozeUntil === null;

export interface AgentDashboardStoreService {
  readonly readFeed: Effect.Effect<ReadonlyArray<AgentDashboardFeedCard>, AgentDashboardStoreError>;
  readonly appendFeed: (
    input: unknown,
  ) => Effect.Effect<AgentDashboardFeedCard, AgentDashboardStoreError>;
  readonly dismissFeedCard: (id: number) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly clearFeed: Effect.Effect<void, AgentDashboardStoreError>;
  readonly readFeedImage: (
    id: number,
  ) => Effect.Effect<AgentDashboardFeedImage | null, AgentDashboardStoreError>;
  readonly readResearchFindings: Effect.Effect<
    ReadonlyArray<AgentDashboardResearchFinding>,
    AgentDashboardStoreError
  >;
  readonly upsertResearchWatchItem: (
    input: AgentDashboardResearchWatchItemInput,
  ) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly readReviewSuggestions: Effect.Effect<
    ReadonlyArray<AgentDashboardReviewSuggestion>,
    AgentDashboardStoreError
  >;
  readonly appendReviewSuggestions: (
    input: AgentDashboardReviewIngestInput,
  ) => Effect.Effect<number, AgentDashboardStoreError>;
  readonly reviewSuggestion: (
    id: string,
    action: "dismiss" | "block",
  ) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly createGithubIssue: (
    id: string,
    githubRepository?: string | null,
    githubEnvironment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly readFindings: Effect.Effect<
    ReadonlyArray<AgentDashboardFinding>,
    AgentDashboardStoreError
  >;
  readonly appendFindings: (
    input: ReadonlyArray<AgentDashboardCanonicalFindingInput>,
  ) => Effect.Effect<number, AgentDashboardStoreError>;
  readonly applyFindingQualifications: (
    input: ReadonlyArray<AgentDashboardFindingQualificationInput>,
  ) => Effect.Effect<number, AgentDashboardStoreError>;
  readonly applyFindingAction: (
    input: AgentDashboardDispositionActionInput,
  ) => Effect.Effect<AgentDashboardStoreMutationOutcome, AgentDashboardStoreError>;
  readonly linkFindingThread: (
    input: AgentDashboardLinkFindingThreadInput,
  ) => Effect.Effect<AgentDashboardStoreMutationOutcome, AgentDashboardStoreError>;
  /** Atomically reserves an open, ready finding for an implementation thread. */
  readonly claimFindingThread: (
    input: AgentDashboardLinkFindingThreadInput,
  ) => Effect.Effect<AgentDashboardStoreMutationOutcome, AgentDashboardStoreError>;
  /** Releases only the matching reservation after a launch failure. */
  readonly releaseFindingThread: (
    input: AgentDashboardLinkFindingThreadInput,
  ) => Effect.Effect<AgentDashboardStoreMutationOutcome, AgentDashboardStoreError>;
  /** Atomically dismisses and releases only the matching automation-owned reservation. */
  readonly resolveStaleFindingReservation: (
    input: AgentDashboardStaleFindingResolutionInput,
  ) => Effect.Effect<AgentDashboardStoreMutationOutcome, AgentDashboardStoreError>;
  readonly readRepositoryPolicies: Effect.Effect<
    ReadonlyArray<AgentDashboardRepositoryPolicy>,
    AgentDashboardStoreError
  >;
  readonly writeRepositoryPolicy: (
    policy: AgentDashboardRepositoryPolicy,
  ) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly readRepositoryCoverage: Effect.Effect<
    ReadonlyArray<AgentDashboardRepositoryCoverage>,
    AgentDashboardStoreError
  >;
  readonly recordAutomationRun: (
    run: AgentDashboardAutomationRun,
  ) => Effect.Effect<void, AgentDashboardStoreError>;
  /** Repair review coverage from durable terminal review history. */
  readonly repairRepositoryCoverage: (
    runs: ReadonlyArray<AgentDashboardAutomationRun>,
  ) => Effect.Effect<void, AgentDashboardStoreError>;
  readonly readExternalActions: Effect.Effect<
    ReadonlyArray<AgentDashboardExternalAction>,
    AgentDashboardStoreError
  >;
  readonly appendExternalAction: (
    action: AgentDashboardExternalAction,
  ) => Effect.Effect<void, AgentDashboardStoreError>;
  readonly readCollectorStates: Effect.Effect<
    ReadonlyArray<AgentDashboardCollectorState>,
    AgentDashboardStoreError
  >;
  readonly writeCollectorState: (
    state: AgentDashboardCollectorState,
  ) => Effect.Effect<void, AgentDashboardStoreError>;
  readonly feedToken: Effect.Effect<string, AgentDashboardStoreError>;
}

export class AgentDashboardStore extends Context.Service<
  AgentDashboardStore,
  AgentDashboardStoreService
>()("t3/agentDashboard/AgentDashboardStore") {}

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const text = (value: unknown, limit = 500): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result.length > 0 ? result.slice(0, limit) : null;
};

const reviewFindingActionability = (
  proposalValue: unknown,
  expectedValueValue: unknown,
  input: {
    readonly type: AgentDashboardFindingType;
    readonly category?: string | null | undefined;
    readonly qualifiedAt: string;
    readonly occurrenceCount: number;
    readonly targets?: AgentDashboardFindingActionability["targets"] | undefined;
    readonly validationPlan?: ReadonlyArray<string> | undefined;
    readonly sources?: AgentDashboardFindingActionability["sources"] | undefined;
    readonly riskTier?: AgentDashboardFindingActionability["riskTier"] | undefined;
    readonly estimatedEffort?: AgentDashboardFindingActionability["estimatedEffort"] | undefined;
    readonly qualificationReason?: string | null | undefined;
  },
): AgentDashboardFindingActionability | null => {
  const proposal = text(proposalValue, 1_200);
  const expectedValue = text(expectedValueValue, 1_200);
  if (!proposal || !expectedValue) return null;
  return {
    readiness: input.category === "product-opportunity" ? "needs-research" : "ready",
    proposal,
    expectedValue,
    targets: input.targets ?? [],
    validationPlan: input.validationPlan ?? [],
    sources: input.sources ?? [],
    riskTier:
      input.riskTier ??
      (input.type === "security" || input.category?.toLocaleLowerCase() === "secrets"
        ? "high"
        : "medium"),
    estimatedEffort: input.estimatedEffort ?? "medium",
    qualificationReason: input.qualificationReason?.trim() || null,
    qualifiedAt: input.qualifiedAt,
    qualifiedBy: "repository-review",
    qualifiedOccurrenceCount: input.occurrenceCount,
  };
};

const reviewSuggestionKey = (repositoryPath: string, title: string): string =>
  `${repositoryPath.trim()}\u0000${title.trim().toLocaleLowerCase()}`;

const list = (value: unknown, limit = 24, itemLimit = 180): Array<string> => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => text(item, itemLimit))
    .filter((item): item is string => item !== null);
};

const integer = (value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(parsed)));
};

const timestamp = (value: unknown, fallback = new Date(0).toISOString()): string => {
  const candidate = text(value, 100);
  if (!candidate) return fallback;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : candidate;
};

const isSafeUrl = (value: string): boolean => /^(?:https?|file):\/\//i.test(value);

const feedAction = (value: unknown): AgentDashboardFeedAction | null => {
  const action = asObject(value);
  const label = text(action?.label, 60);
  if (!label) return null;

  const url = text(action?.url, 2_000);
  const file = text(action?.file, 1_000);
  if (url && !isSafeUrl(url)) return null;
  if (!url && !file) return null;

  return {
    label,
    ...(url ? { url } : {}),
    ...(file ? { file } : {}),
    ...(action?.reveal === true ? { reveal: true } : {}),
  };
};

const feedOrigin = (source: JsonObject): AgentDashboardFeedOrigin => {
  const nested = asObject(source.origin) ?? {};
  const projectId = text(
    nested.projectId ?? nested.project_id ?? source.projectId ?? source.project_id,
    200,
  );
  const projectName = text(
    nested.projectName ?? nested.project_name ?? source.projectName ?? source.project_name,
    200,
  );
  const projectPath = text(
    nested.projectPath ??
      nested.project_path ??
      nested.path ??
      source.projectPath ??
      source.project_path ??
      source.workspaceRoot ??
      source.workspace_root ??
      source.cwd,
    2_000,
  );
  const threadId = text(
    nested.threadId ?? nested.thread_id ?? source.threadId ?? source.thread_id,
    200,
  );

  return {
    projectId: projectId === null ? null : ProjectId.make(projectId),
    projectName,
    projectPath,
    threadId: threadId === null ? null : ThreadId.make(threadId),
  };
};

const feedCard = (raw: unknown, id: number, nowSeconds: number): AgentDashboardFeedCard => {
  const source = asObject(raw) ?? {};
  const imageUrl = text(source.image_url ?? source.imageUrl, 4_000);
  const rawActions = Array.isArray(source.actions)
    ? source.actions
        .slice(0, 8)
        .map(feedAction)
        .filter((action): action is AgentDashboardFeedAction => action !== null)
    : [];
  const level = text(source.level, 20);
  const normalizedLevel: AgentDashboardFeedCard["level"] =
    level === "success" || level === "warn" || level === "error" ? level : "info";
  const title = text(source.title, 200);
  const body = text(source.text, MAX_TEXT);
  const persistedImage = text(source.image_file, 2_000);

  return {
    id,
    ts: typeof source.ts === "number" && Number.isFinite(source.ts) ? source.ts : nowSeconds,
    agent: text(source.agent, 80) ?? "agent",
    kind: text(source.kind, 80),
    title,
    text: body,
    imageUrl:
      persistedImage || imageUrl?.startsWith("/img/") ? `/api/agent-feed/img/${id}` : imageUrl,
    level: normalizedLevel,
    tags: list(source.tags, 12, 40),
    ...(source.chart !== undefined ? { chart: source.chart } : {}),
    ...(source.research !== undefined ? { research: source.research } : {}),
    ...(source.focus !== undefined ? { focus: source.focus } : {}),
    actions: rawActions,
    origin: feedOrigin(source),
  };
};

const rawFeedCard = (raw: unknown, id: number): JsonObject => {
  const source = asObject(raw) ?? {};
  const card: JsonObject = {
    id,
    ts: typeof source.ts === "number" && Number.isFinite(source.ts) ? source.ts : Date.now() / 1000,
    agent: text(source.agent, 80) ?? "agent",
    level: ["info", "success", "warn", "error"].includes(String(source.level))
      ? source.level
      : "info",
  };

  for (const [sourceKey, targetKey, limit] of [
    ["kind", "kind", 80],
    ["title", "title", 200],
    ["text", "text", MAX_TEXT],
    ["image_url", "image_url", 4_000],
    ["image_file", "image_file", 2_000],
  ] as const) {
    const value = text(source[sourceKey], limit);
    if (value) card[targetKey] = value;
  }

  const tags = list(source.tags, 12, 40);
  if (tags.length > 0) card.tags = tags;
  for (const key of ["chart", "research", "focus"] as const) {
    if (source[key] !== undefined) card[key] = source[key];
  }
  const actions = Array.isArray(source.actions)
    ? source.actions
        .slice(0, 8)
        .map(feedAction)
        .filter((action): action is AgentDashboardFeedAction => action !== null)
    : [];
  if (actions.length > 0) card.actions = actions;
  const origin = feedOrigin(source);
  if (origin.projectId !== null) card.project_id = origin.projectId;
  if (origin.projectName !== null) card.project_name = origin.projectName;
  if (origin.projectPath !== null) card.project_path = origin.projectPath;
  if (origin.threadId !== null) card.thread_id = origin.threadId;
  if (!(card.title || card.text || card.image_url || card.image_file || card.chart)) {
    throw new Error("feed card needs title, text, image, or chart content");
  }
  return card;
};

const jsonLines = async (path: string): Promise<Array<JsonObject>> => {
  try {
    const contents = await NodeFSP.readFile(path, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => {
        try {
          return asObject(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((item): item is JsonObject => item !== null);
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return [];
    throw cause;
  }
};

const jsonDocument = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return null;
    throw cause;
  }
};

const writeAtomic = async (path: string, contents: string): Promise<void> => {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
};

const readLegacySuggestionRecords = (value: unknown): Array<JsonObject> => {
  const object = asObject(value);
  const records = Array.isArray(object?.suggestions)
    ? object.suggestions
    : Array.isArray(value)
      ? value
      : [];
  return records.map(asObject).filter((item): item is JsonObject => item !== null);
};

const runExecutable = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout?: number;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeout ?? 30_000,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        };
        if (error) {
          const detail = [output.stderr.trim(), output.stdout.trim(), error.message.trim()]
            .filter((part) => part.length > 0)
            .join("\n");
          reject(new Error(detail || `Command '${command}' failed.`));
          return;
        }
        resolve(output);
      },
    );
  });

/**
 * Review findings must point at a durable repository checkout. Linked
 * worktrees are disposable review targets: they can be pruned after the
 * investigation finishes, leaving the dashboard with a path that cannot be
 * opened when the user chooses "Work on this".
 */
export const isStableRepositoryPath = async (repositoryPath: string): Promise<boolean> => {
  if (!NodePath.isAbsolute(repositoryPath)) return false;

  try {
    const repositoryStat = await NodeFSP.stat(repositoryPath);
    if (!repositoryStat.isDirectory()) return false;
    const gitStat = await NodeFSP.lstat(NodePath.join(repositoryPath, ".git"));
    if (!gitStat.isDirectory() && !gitStat.isFile()) return false;

    const result = await runExecutable(
      "git",
      ["-C", repositoryPath, "rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"],
      { timeout: 5_000 },
    );
    const [gitDir, commonGitDir, repositoryRoot] = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (!gitDir || !commonGitDir || !repositoryRoot) return false;

    const resolveGitPath = (gitPath: string): string =>
      NodePath.isAbsolute(gitPath) ? gitPath : NodePath.resolve(repositoryPath, gitPath);
    const [resolvedPath, resolvedRoot, resolvedGitDir, resolvedCommonGitDir] = await Promise.all([
      NodeFSP.realpath(repositoryPath),
      NodeFSP.realpath(repositoryRoot),
      NodeFSP.realpath(resolveGitPath(gitDir)),
      NodeFSP.realpath(resolveGitPath(commonGitDir)),
    ]);
    // Git submodule checkouts use a .git pointer file but share the same
    // common directory as their git dir. Linked worktrees have a separate
    // per-worktree git dir, so reject those disposable paths.
    return resolvedPath === resolvedRoot && resolvedGitDir === resolvedCommonGitDir;
  } catch {
    return false;
  }
};

const normalizeResearch = (
  raw: JsonObject,
  lineNumber: number,
): AgentDashboardResearchFinding | null => {
  const nested = asObject(raw.finding);
  const finding = nested ?? raw;
  const id = text(finding.finding_id ?? finding.id ?? finding.arxiv_id ?? finding.paper_id, 200);
  const source = text(finding.source, 80) ?? "unknown";
  const title = text(finding.title, 300);
  if (!title) return null;
  const url = text(finding.url, 2_000);
  const stableId = id ?? url ?? `line:${lineNumber}`;
  const relevanceScore = integer(finding.relevance_score ?? finding.relevance, 0, 100);
  const rawTimestamp = raw.timestamp ?? finding.timestamp ?? finding.scanned_at;
  const rawSinceDays = finding.since_days;
  const rawCitationCount = finding.citation_count;
  return {
    id: stableId,
    title,
    source,
    url: url && isSafeUrl(url) ? url : null,
    timestamp: timestamp(rawTimestamp),
    abstract: text(finding.abstract ?? finding.summary, 4_000),
    authors: list(finding.authors, 16, 180),
    published: text(finding.published, 80),
    categories: list(finding.categories, 16, 80),
    relevanceScore,
    topicContext: text(finding.topic_context ?? finding._topic_context, 1_000),
    repositories: list(
      finding.repositories ?? (finding.repository ? [finding.repository] : []),
      24,
      500,
    ),
    watchDir: text(finding.watch_dir, 500),
    sinceDays: rawSinceDays === undefined ? null : integer(rawSinceDays, 0, 3_650),
    pdfUrl:
      text(finding.pdf_url, 2_000) && isSafeUrl(text(finding.pdf_url, 2_000) as string)
        ? text(finding.pdf_url, 2_000)
        : null,
    citationCount: rawCitationCount === undefined ? null : integer(rawCitationCount, 0, 10_000_000),
    occurrences: Math.max(1, integer(raw.occurrences, 1, 1_000_000)),
  };
};

const normalizeSuggestion = (raw: JsonObject): AgentDashboardReviewSuggestion | null => {
  if (raw.source !== "code_review") return null;
  const id = text(raw.id, 100);
  const title = text(raw.title, 300);
  if (!id || !title) return null;
  const repository = asObject(raw.repository) ?? {};
  const issue = asObject(raw.github_issue) ?? {};
  const status = ["pending", "accepted", "dismissed", "blocked"].includes(String(raw.status))
    ? (raw.status as AgentDashboardReviewSuggestion["status"])
    : "pending";
  return {
    id,
    profile: text(raw.profile, 100),
    title,
    description: text(raw.description, 4_000) ?? title,
    source: "code_review",
    status,
    createdAt: timestamp(raw.created_at),
    expiresAt: raw.expires_at ? timestamp(raw.expires_at) : null,
    repository: {
      name: text(repository.name, 200) ?? "Unknown repository",
      path: text(repository.path, 1_000) ?? "unknown",
      githubRepo: text(repository.github_repo, 250),
    },
    category: text(raw.category, 40) ?? "insight",
    impact: text(raw.impact, 1_200) ?? "",
    confidence: text(raw.confidence, 40) ?? "medium",
    evidence: list(raw.evidence, 24, 1_000),
    nextStep: text(raw.next_step, 1_200) ?? "",
    report: text(raw.report, 16_000) ?? text(raw.description, 4_000) ?? title,
    githubIssue: {
      title: text(issue.title, 300) ?? title,
      body: text(issue.body, 16_000) ?? text(raw.description, 4_000) ?? title,
      url: text(issue.url, 2_000),
      number: issue.number === null || issue.number === undefined ? null : integer(issue.number, 0),
    },
    jobId: text(raw.job_id, 200),
  };
};

const makeStore = (stateDir: string): AgentDashboardStoreService => {
  const directory = NodePath.join(stateDir, "agent-dashboard");
  const feedPath = NodePath.join(directory, "feed.jsonl");
  const feedLegacyCursorPath = NodePath.join(directory, "feed.legacy-cursor");
  const assetsDir = NodePath.join(directory, "assets");
  const researchPath = NodePath.join(directory, "research_findings.jsonl");
  const researchWatchlistPath = NodePath.join(directory, "research-watchlist.json");
  const suggestionsPath = NodePath.join(directory, "suggestions.json");
  const findingsPath = NodePath.join(directory, "findings.json");
  const policiesPath = NodePath.join(directory, "repository-policies.json");
  const coveragePath = NodePath.join(directory, "repository-coverage.json");
  const externalActionsPath = NodePath.join(directory, "external-actions.json");
  const collectorStatesPath = NodePath.join(directory, "collector-states.json");
  const tokenPath = NodePath.join(directory, "feed.token");
  const legacyFeedPath = NodePath.join(
    NodeOS.homedir(),
    ".local",
    "share",
    "agent-widget",
    "feed.jsonl",
  );
  const legacyResearchPath = NodePath.join(NodeOS.homedir(), ".hermes", "research_findings.jsonl");
  const legacySuggestionsPath = NodePath.join(
    NodeOS.homedir(),
    ".hermes",
    "cron",
    "suggestions.json",
  );

  let initialized: Promise<void> | null = null;
  let mutation = Promise.resolve();
  let lastLegacyFeedSignature: string | null = null;

  const isPathInsideRoot = (root: string, candidate: string): boolean => {
    const relative = NodePath.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
  };

  const resolveOwnedImagePath = async (imagePath: string): Promise<string | null> => {
    if (!imagePath || imagePath.includes("\0")) return null;
    try {
      await NodeFSP.mkdir(assetsDir, { recursive: true });
      const assetsRoot = await NodeFSP.realpath(assetsDir);
      const candidate = NodePath.isAbsolute(imagePath)
        ? imagePath
        : NodePath.resolve(assetsDir, imagePath);
      // realpath collapses symlinks; containment after that blocks escape.
      const realFile = await NodeFSP.realpath(candidate);
      if (!isPathInsideRoot(assetsRoot, realFile)) return null;
      const info = await NodeFSP.stat(realFile);
      if (!info.isFile() || info.size > MAX_FEED_IMAGE_BYTES) return null;
      const extension = NodePath.extname(realFile).toLowerCase();
      if (!FEED_IMAGE_CONTENT_TYPES[extension]) return null;
      return realFile;
    } catch {
      return null;
    }
  };

  const importFeedImage = async (sourceSpec: string, cardId: number): Promise<string | null> => {
    if (!sourceSpec || sourceSpec.includes("\0")) return null;
    // Publishers may only hand us absolute local paths (widget contract).
    if (!NodePath.isAbsolute(sourceSpec)) return null;
    const extension = NodePath.extname(sourceSpec).toLowerCase();
    if (!FEED_IMAGE_CONTENT_TYPES[extension]) return null;
    try {
      const info = await NodeFSP.stat(sourceSpec);
      if (!info.isFile() || info.size > MAX_FEED_IMAGE_BYTES) return null;
      const bytes = await NodeFSP.readFile(sourceSpec);
      await NodeFSP.mkdir(assetsDir, { recursive: true });
      const destination = NodePath.join(assetsDir, `${cardId}${extension}`);
      // Never write through a pre-existing symlink in the assets directory.
      try {
        const existing = await NodeFSP.lstat(destination);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          await NodeFSP.rm(destination, { force: true });
        }
      } catch (cause) {
        if (asObject(cause)?.code !== "ENOENT") throw cause;
      }
      await NodeFSP.writeFile(destination, bytes, { mode: 0o600, flag: "w" });
      return await resolveOwnedImagePath(destination);
    } catch {
      return null;
    }
  };

  const attachOwnedImage = async (card: JsonObject, cardId: number): Promise<JsonObject> => {
    const imageFile = text(card.image_file, 2_000);
    if (!imageFile) return card;
    const owned = await resolveOwnedImagePath(imageFile);
    if (owned) {
      return owned === imageFile ? card : { ...card, image_file: owned };
    }
    const imported = await importFeedImage(imageFile, cardId);
    if (!imported) {
      const { image_file: _removed, ...rest } = card;
      return rest;
    }
    return { ...card, image_file: imported };
  };

  const readLegacyCursor = async (): Promise<number> => {
    try {
      const raw = (await NodeFSP.readFile(feedLegacyCursorPath, "utf8")).trim();
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    } catch (cause) {
      if (asObject(cause)?.code === "ENOENT") return 0;
      throw cause;
    }
  };

  const legacyFeedSignature = async (): Promise<string | null> => {
    try {
      const info = await NodeFSP.stat(legacyFeedPath);
      return `${info.size}:${Math.trunc(info.mtimeMs)}`;
    } catch (cause) {
      if (asObject(cause)?.code === "ENOENT") return null;
      throw cause;
    }
  };

  const ingestLegacyFeed = async (): Promise<void> => {
    const signature = await legacyFeedSignature();
    if (signature !== null && signature === lastLegacyFeedSignature) {
      return;
    }

    let legacyCards: Array<JsonObject> = [];
    try {
      legacyCards = await jsonLines(legacyFeedPath);
    } catch (cause) {
      if (asObject(cause)?.code !== "ENOENT") throw cause;
    }

    const cursor = await readLegacyCursor();
    const localCards = await jsonLines(feedPath);
    const byId = new Map<number, JsonObject>();
    for (const card of localCards) {
      byId.set(integer(card.id, 0), card);
    }

    let changed = false;
    let maxSeen = cursor;
    for (const legacyCard of legacyCards) {
      const id = integer(legacyCard.id, 0);
      if (id <= 0) continue;
      maxSeen = Math.max(maxSeen, id);
      if (id <= cursor) continue;
      if (byId.has(id)) continue;
      const prepared = await attachOwnedImage({ ...legacyCard, id }, id);
      byId.set(id, prepared);
      changed = true;
    }

    if (changed) {
      const merged = [...byId.values()].toSorted(
        (left, right) => integer(left.id, 0) - integer(right.id, 0),
      );
      await writeAtomic(
        feedPath,
        merged.length === 0 ? "" : `${merged.map((card) => JSON.stringify(card)).join("\n")}\n`,
      );
    }
    if (maxSeen > cursor) {
      await writeAtomic(feedLegacyCursorPath, `${maxSeen}\n`);
    }
    lastLegacyFeedSignature = signature;
  };

  const ensureOwnedFeedImages = async (): Promise<void> => {
    const cards = await jsonLines(feedPath);
    let changed = false;
    const next: Array<JsonObject> = [];
    for (const card of cards) {
      const id = integer(card.id, 0);
      const prepared = await attachOwnedImage(card, id);
      if (prepared !== card && JSON.stringify(prepared) !== JSON.stringify(card)) {
        changed = true;
      }
      next.push(prepared);
    }
    if (changed) {
      await writeAtomic(
        feedPath,
        next.length === 0 ? "" : `${next.map((card) => JSON.stringify(card)).join("\n")}\n`,
      );
    }
  };

  const initialize = (): Promise<void> => {
    if (initialized) return initialized;
    initialized = (async () => {
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.mkdir(assetsDir, { recursive: true });
      // Continuous, idempotent legacy ingestion replaces the one-shot empty-feed copy.
      await ingestLegacyFeed();
      await pruneExpiredFeed();
      await ensureOwnedFeedImages();
      for (const [target, legacy] of [
        [researchPath, legacyResearchPath],
        [suggestionsPath, legacySuggestionsPath],
      ] as const) {
        try {
          await NodeFSP.access(target);
        } catch {
          try {
            await NodeFSP.copyFile(legacy, target);
          } catch {
            // A missing legacy store is a normal first-run state.
          }
        }
      }
      try {
        await NodeFSP.access(tokenPath);
      } catch {
        const configured = process.env.T3_AGENT_FEED_TOKEN?.trim();
        const token = configured || NodeCrypto.randomBytes(32).toString("base64url");
        await NodeFSP.writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      }
    })();
    return initialized;
  };

  const run = <A>(operation: string, task: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        await initialize();
        // Continuous legacy ingestion: no-ops (no state writes) when the legacy
        // feed signature is unchanged, so repeated pure reads keep stable mtimes.
        await ingestLegacyFeed();
        await pruneExpiredFeed();
        return await task();
      },
      catch: (cause) => new AgentDashboardStoreError({ operation, cause }),
    });

  const withMutation = <A>(task: () => Promise<A>): Promise<A> => {
    const next = mutation.then(task, task);
    mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const readDocumentArray = async (path: string, key: string): Promise<Array<JsonObject>> => {
    const raw = await jsonDocument(path);
    const object = asObject(raw);
    const values = Array.isArray(object?.[key]) ? object[key] : Array.isArray(raw) ? raw : [];
    return values.map(asObject).filter((value): value is JsonObject => value !== null);
  };

  const writeDocumentArray = async (
    path: string,
    key: string,
    values: ReadonlyArray<JsonObject>,
  ): Promise<void> => {
    await writeAtomic(
      path,
      JSON.stringify({ [key]: values, updated_at: new Date().toISOString() }, null, 2),
    );
  };

  const findingType = (
    input: Pick<AgentDashboardCanonicalFindingInput, "category" | "kind" | "type">,
  ): AgentDashboardFindingType => {
    if (input.type) return input.type;
    const category = input.category?.trim().toLocaleLowerCase() ?? "";
    if (input.kind === "security") return "security";
    if (input.kind === "research") return "research";
    if (["bug", "defect", "error", "regression"].includes(category)) return "bug";
    if (input.kind === "operational") return "operations";
    if (
      input.kind === "engineering" ||
      ["feature", "gap", "improvement", "performance", "quality", "maintainability"].includes(
        category,
      )
    ) {
      return "improvement";
    }
    return "review";
  };

  const persistedFindingType = (value: unknown): AgentDashboardFindingType | undefined => {
    switch (value) {
      case "bug":
      case "security":
      case "research":
      case "improvement":
      case "review":
      case "operations":
        return value;
      default:
        return undefined;
    }
  };

  const persistedFindingKind = (value: unknown): AgentDashboardFindingKind => {
    switch (value) {
      case "review":
      case "research":
      case "security":
      case "engineering":
      case "operational":
        return value;
      default:
        return "review";
    }
  };

  const decodeFinding = (value: unknown): AgentDashboardFinding | null => {
    try {
      const raw = asObject(value);
      if (!raw) return null;
      return decodeAgentDashboardFinding({
        ...raw,
        type: findingType({
          type: persistedFindingType(raw.type),
          kind: persistedFindingKind(raw.kind),
          category: text(raw.category, 80),
        }),
      });
    } catch {
      return null;
    }
  };

  const decodePolicy = (value: unknown): AgentDashboardRepositoryPolicy | null => {
    try {
      return decodeAgentDashboardRepositoryPolicy(value);
    } catch {
      return null;
    }
  };

  const decodeCoverage = (value: unknown): AgentDashboardRepositoryCoverage | null => {
    try {
      return decodeAgentDashboardRepositoryCoverage(value);
    } catch {
      return null;
    }
  };

  const decodeExternalAction = (value: unknown): AgentDashboardExternalAction | null => {
    try {
      return decodeAgentDashboardExternalAction(value);
    } catch {
      return null;
    }
  };

  const decodeCollectorState = (value: unknown): AgentDashboardCollectorState | null => {
    try {
      return decodeAgentDashboardCollectorState(value);
    } catch {
      return null;
    }
  };

  const readCanonicalFindingsRaw = async (): Promise<Array<AgentDashboardFinding>> =>
    (await readDocumentArray(findingsPath, "findings"))
      .map(decodeFinding)
      .filter((value): value is AgentDashboardFinding => value !== null);

  const findingSeverity = (
    input: AgentDashboardCanonicalFindingInput,
  ): AgentDashboardFindingSeverity => {
    if (input.severity) return input.severity;
    const textValue = `${input.title} ${input.summary} ${input.category ?? ""}`.toLowerCase();
    if (/(critical|credential|secret|remote code|data loss)/.test(textValue)) return "critical";
    if (/(security|vulnerability|crash|corrupt)/.test(textValue)) return "high";
    if (/(bug|failure|missing|unsafe)/.test(textValue)) return "medium";
    return "low";
  };

  const findingConfidence = (
    input: AgentDashboardCanonicalFindingInput,
  ): AgentDashboardFindingConfidence => input.confidence ?? "medium";

  const stableFindingFingerprint = (input: AgentDashboardCanonicalFindingInput): string => {
    const normalized = {
      repository: input.repository.projectId.trim(),
      kind: input.kind,
      title: input.title.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
      category: input.category?.trim().replace(/\s+/g, " ").toLocaleLowerCase() ?? "",
      evidence: (input.evidence ?? [])
        .map((item) => item.trim().replace(/\s+/g, " ").toLocaleLowerCase())
        .filter(Boolean)
        .toSorted(),
    };
    return `finding:${NodeCrypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32)}`;
  };

  const findingTitleTokens = (title: string): ReadonlySet<string> => {
    const stopWords = new Set([
      "a",
      "an",
      "and",
      "for",
      "in",
      "is",
      "of",
      "on",
      "the",
      "to",
      "with",
    ]);
    return new Set(
      title
        .toLocaleLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !stopWords.has(token)),
    );
  };

  const findingCodePaths = (input: {
    readonly evidence: ReadonlyArray<string>;
    readonly actionability: AgentDashboardFinding["actionability"];
  }): ReadonlySet<string> => {
    const paths = new Set(
      input.actionability?.targets
        .map((target) => target.path.trim().toLocaleLowerCase())
        .filter(Boolean) ?? [],
    );
    const pathPattern = /(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+)(?::\d+)?/gi;
    for (const evidence of input.evidence) {
      for (const match of evidence.matchAll(pathPattern)) {
        if (match[1]) paths.add(match[1].toLocaleLowerCase());
      }
    }
    return paths;
  };

  const overlapRatio = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
    if (left.size === 0 || right.size === 0) return 0;
    let overlap = 0;
    for (const value of left) if (right.has(value)) overlap += 1;
    return overlap / new Set([...left, ...right]).size;
  };

  const isSemanticDuplicate = (
    existing: AgentDashboardFinding,
    input: AgentDashboardCanonicalFindingInput,
  ): boolean => {
    if (
      String(existing.repository.projectId) !== input.repository.projectId.trim() ||
      existing.type !== findingType(input) ||
      (existing.category ?? "").toLocaleLowerCase() !==
        (input.category?.trim() ?? "").toLocaleLowerCase()
    ) {
      return false;
    }
    const titleOverlap = overlapRatio(
      findingTitleTokens(existing.title),
      findingTitleTokens(input.title),
    );
    const pathOverlap = overlapRatio(
      findingCodePaths(existing),
      findingCodePaths({
        evidence: input.evidence ?? [],
        actionability: input.actionability ?? null,
      }),
    );
    return titleOverlap >= 0.72 || (pathOverlap > 0 && titleOverlap >= 0.45);
  };

  const mergeCanonicalFindings = async (
    inputs: ReadonlyArray<AgentDashboardCanonicalFindingInput>,
  ): Promise<number> => {
    const existing = await readCanonicalFindingsRaw();
    const byFingerprint = new Map(existing.map((finding) => [finding.fingerprint, finding]));
    const now = new Date().toISOString();
    let changed = 0;

    for (const input of inputs.slice(0, 100)) {
      const title = input.title.trim().slice(0, 300);
      if (!title || !input.repository.projectId.trim()) continue;
      const evidence = (input.evidence ?? [])
        .map((item) => item.trim().slice(0, 1_000))
        .filter(Boolean)
        .slice(0, 24);
      const candidateFingerprint = stableFindingFingerprint({ ...input, title, evidence });
      const previous =
        byFingerprint.get(candidateFingerprint) ??
        [...byFingerprint.values()].find((finding) =>
          isSemanticDuplicate(finding, { ...input, title, evidence }),
        );
      const fingerprint = previous?.fingerprint ?? candidateFingerprint;
      const id = previous?.id ?? fingerprint;
      const next: AgentDashboardFinding = {
        id,
        fingerprint,
        type: findingType(input),
        kind: input.kind,
        title,
        summary: input.summary.trim().slice(0, 4_000) || title,
        severity: findingSeverity(input),
        confidence: findingConfidence(input),
        category: input.category?.trim().slice(0, 80) || null,
        evidence,
        repository: { projectId: ProjectId.make(input.repository.projectId.trim()) },
        repositoryPath: input.repositoryPath?.trim().slice(0, 2_000) || null,
        disposition: previous?.disposition ?? {
          state: "open",
          updatedAt: now,
          actor: null,
          note: null,
          snoozeUntil: null,
          assignee: null,
        },
        provenance: {
          source: input.source.trim().slice(0, 120) || "agent-dashboard",
          sourceAt: input.sourceAt ? timestamp(input.sourceAt, now) : null,
          collectedAt: input.collectedAt ? timestamp(input.collectedAt, now) : now,
        },
        firstSeenAt: previous?.firstSeenAt ?? now,
        lastSeenAt: now,
        occurrenceCount: Math.min(1_000_000, (previous?.occurrenceCount ?? 0) + 1),
        lastRunId: input.runId?.trim() || previous?.lastRunId || null,
        thread: input.threadId?.trim()
          ? {
              projectId: ProjectId.make(input.repository.projectId.trim()),
              threadId: ThreadId.make(input.threadId.trim()),
            }
          : (previous?.thread ?? null),
        externalIssueUrl: input.externalIssueUrl?.trim() || previous?.externalIssueUrl || null,
        actionability: input.actionability ?? previous?.actionability ?? null,
      };
      byFingerprint.set(fingerprint, next);
      changed += 1;
    }

    if (changed > 0) {
      await writeDocumentArray(findingsPath, "findings", [...byFingerprint.values()]);
    }
    return changed;
  };

  const readReviewSuggestionRaw = async (): Promise<Array<JsonObject>> => {
    const local = readLegacySuggestionRecords(await jsonDocument(suggestionsPath));
    const legacy = readLegacySuggestionRecords(await jsonDocument(legacySuggestionsPath));
    const byId = new Map<string, JsonObject>();

    for (const record of legacy) {
      const id = text(record.id, 100);
      if (id) byId.set(id, record);
    }
    for (const record of local) {
      const id = text(record.id, 100);
      if (!id) continue;
      const previous = byId.get(id);
      if (!previous) {
        byId.set(id, record);
        continue;
      }

      const previousIssue = asObject(previous.github_issue) ?? {};
      const currentIssue = asObject(record.github_issue) ?? {};
      byId.set(id, {
        ...previous,
        ...record,
        github_issue: {
          ...previousIssue,
          ...currentIssue,
          title: text(currentIssue.title, 300) ?? text(previousIssue.title, 300),
          body: text(currentIssue.body, 16_000) ?? text(previousIssue.body, 16_000),
          url: text(currentIssue.url, 2_000) ?? text(previousIssue.url, 2_000),
          number: currentIssue.number ?? previousIssue.number ?? null,
        },
      });
    }

    return [...byId.values()];
  };

  const readFeedRaw = async (): Promise<Array<JsonObject>> => jsonLines(feedPath);

  const feedTimestampSeconds = (card: JsonObject, fallback: number): number => {
    const value = card.ts;
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };

  const removeDroppedFeedAssets = async (
    previous: ReadonlyArray<JsonObject>,
    kept: ReadonlyArray<JsonObject>,
  ): Promise<void> => {
    const keptImages = new Set(
      kept
        .map((card) => text(card.image_file, 2_000))
        .filter((path): path is string => path !== null),
    );
    for (const card of previous) {
      const imagePath = text(card.image_file, 2_000);
      if (!imagePath || keptImages.has(imagePath)) continue;
      const owned = await resolveOwnedImagePath(imagePath);
      if (owned) await NodeFSP.rm(owned, { force: true });
    }
  };

  const persistFeed = async (cards: ReadonlyArray<JsonObject>): Promise<void> => {
    const nowSeconds = Date.now() / 1000;
    const cutoff = nowSeconds - AGENT_FEED_RETENTION_SECONDS;
    const kept = cards
      .filter((card) => feedTimestampSeconds(card, nowSeconds) >= cutoff)
      .slice(-MAX_FEED_CARDS);
    const previous = await readFeedRaw();
    await removeDroppedFeedAssets(previous, kept);
    await writeAtomic(
      feedPath,
      kept.length === 0 ? "" : `${kept.map((card) => JSON.stringify(card)).join("\n")}\n`,
    );
  };

  const pruneExpiredFeed = async (): Promise<void> => {
    const cards = await readFeedRaw();
    const cutoff = Date.now() / 1000 - AGENT_FEED_RETENTION_SECONDS;
    if (cards.every((card) => feedTimestampSeconds(card, cutoff) >= cutoff)) return;
    await persistFeed(cards);
  };

  const readFeed = run("read feed", async () => {
    const cards = await readFeedRaw();
    return cards
      .map((card) => integer(card.id, 0))
      .map((id, index) => feedCard(cards[index], id, 0))
      .toSorted((left, right) => right.id - left.id);
  });

  const appendFeed = (input: unknown) =>
    run("append feed card", () =>
      withMutation(async () => {
        const cards = await readFeedRaw();
        const nextId = cards.reduce((max, card) => Math.max(max, integer(card.id, 0)), 0) + 1;
        const raw = await attachOwnedImage(rawFeedCard(input, nextId), nextId);
        await persistFeed([...cards, raw]);
        return feedCard(raw, nextId, Number(raw.ts));
      }),
    );

  const dismissFeedCard = (id: number) =>
    run("dismiss feed card", () =>
      withMutation(async () => {
        const cards = await readFeedRaw();
        const remaining = cards.filter((card) => integer(card.id, 0) !== id);
        if (remaining.length === cards.length) return false;
        await persistFeed(remaining);
        return true;
      }),
    );

  const clearFeed = run("clear feed", () =>
    withMutation(async () => {
      await persistFeed([]);
    }),
  );

  const readFeedImage = (id: number) =>
    run("read feed image", async () => {
      const cards = await readFeedRaw();
      const card = cards.find((entry) => integer(entry.id, 0) === id);
      const imagePath = text(card?.image_file, 2_000);
      if (!imagePath) return null;
      // Serve only dashboard-owned asset files. Absolute paths outside assets/,
      // traversal, and symlink escapes all resolve to null.
      const ownedPath = await resolveOwnedImagePath(imagePath);
      if (!ownedPath) return null;
      try {
        const bytes = await NodeFSP.readFile(ownedPath);
        const extension = NodePath.extname(ownedPath).toLowerCase();
        return {
          bytes,
          contentType: FEED_IMAGE_CONTENT_TYPES[extension] ?? "application/octet-stream",
        };
      } catch (cause) {
        if (asObject(cause)?.code === "ENOENT") return null;
        throw cause;
      }
    });

  const upsertResearchWatchItem = (input: AgentDashboardResearchWatchItemInput) =>
    run("save research watch item", () =>
      withMutation(async () => {
        const items = await readDocumentArray(researchWatchlistPath, "items");
        const projectId = String(input.projectId);
        const title = String(input.title).trim().slice(0, 300);
        const summary = String(input.summary).trim().slice(0, 4_000);
        const key = `${projectId}:${title.toLocaleLowerCase()}`;
        const previousIndex = items.findIndex((item) => {
          const repository = text(item.projectId ?? item.repository, 200);
          const itemTitle = text(item.title, 300);
          return repository !== null && itemTitle !== null
            ? `${repository}:${itemTitle.toLocaleLowerCase()}` === key
            : false;
        });
        const previous = previousIndex >= 0 ? items[previousIndex] : null;
        const next: JsonObject = {
          ...previous,
          projectId,
          title,
          summary,
          url: input.url?.trim() || null,
          category: input.category?.trim() || "watchlist",
          updatedAt: new Date().toISOString(),
        };
        const changed = previous === null || JSON.stringify(previous) !== JSON.stringify(next);
        if (!changed) return false;
        const updated = [...items];
        if (previousIndex >= 0) updated[previousIndex] = next;
        else updated.push(next);
        await writeDocumentArray(researchWatchlistPath, "items", updated);
        return true;
      }),
    );

  const readResearchFindings = run("read research findings", async () => {
    const target = await jsonLines(researchPath);
    const byId = new Map<string, AgentDashboardResearchFinding>();
    for (const [index, record] of target.entries()) {
      const normalized = normalizeResearch(record, index + 1);
      if (!normalized) continue;
      const existing = byId.get(normalized.id);
      byId.set(
        normalized.id,
        existing
          ? {
              ...existing,
              ...normalized,
              occurrences: existing.occurrences + normalized.occurrences,
            }
          : normalized,
      );
    }
    // Read path is side-effect free: normalize in memory only.
    return [...byId.values()]
      .toSorted(
        (left, right) =>
          Date.parse(right.timestamp) - Date.parse(left.timestamp) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, MAX_RESEARCH_FINDINGS);
  });

  const readReviewSuggestions = run("read review suggestions", async () => {
    const target = await readReviewSuggestionRaw();
    const byId = new Map<string, JsonObject>();
    for (const record of target) {
      const id = text(record.id, 100);
      if (id) byId.set(id, record);
    }
    const all = [...byId.values()];
    const now = Date.now();
    const visible: Array<AgentDashboardReviewSuggestion> = [];
    for (const record of all) {
      const suggestion = normalizeSuggestion(record);
      if (!suggestion || suggestion.status !== "pending") continue;
      if (suggestion.expiresAt !== null && Date.parse(suggestion.expiresAt) <= now) continue;
      // Filter unstable targets in memory only — do not rewrite suggestions on read.
      if (!(await isStableRepositoryPath(suggestion.repository.path))) continue;
      visible.push(suggestion);
    }

    return visible.toSorted(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id),
    );
  });

  const appendReviewSuggestions = (input: AgentDashboardReviewIngestInput) =>
    run("append review suggestions", () =>
      withMutation(async () => {
        const existingRecords = await readReviewSuggestionRaw();
        const byId = new Map<string, JsonObject>();
        for (const record of existingRecords) {
          const recordId = text(record.id, 100);
          if (recordId) byId.set(recordId, record);
        }

        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString();
        let changed = 0;
        const canonicalInputs: Array<AgentDashboardCanonicalFindingInput> = [];
        const migratedDispositions = new Map<string, "acknowledged" | "dismissed" | "blocked">();
        for (const finding of input.findings.slice(0, 6)) {
          const title = finding.title.trim().slice(0, 300);
          if (!title) continue;
          const canonicalInput: AgentDashboardCanonicalFindingInput = {
            type: finding.type,
            kind: "review",
            title,
            summary: finding.summary,
            confidence:
              finding.confidence === "high" || finding.confidence === "low"
                ? finding.confidence
                : "medium",
            category: finding.category,
            evidence: finding.evidence,
            repository: { projectId: input.projectId ?? "pending-selection" },
            repositoryPath: input.repository.path,
            source: "code_review",
            sourceAt: createdAt,
            collectedAt: createdAt,
            runId: input.runId ?? input.jobId,
            threadId: input.threadId ?? null,
            actionability: reviewFindingActionability(finding.nextStep, finding.impact, {
              type: finding.type,
              category: finding.category,
              qualifiedAt: createdAt,
              occurrenceCount: 1,
              targets: finding.targets,
              validationPlan: finding.validationPlan,
              sources: finding.sources,
              riskTier: finding.automationRisk,
              estimatedEffort: finding.estimatedEffort,
              qualificationReason: finding.qualificationReason,
            }),
          };
          const fingerprint = stableFindingFingerprint(canonicalInput);
          const id = `t3-review-${fingerprint.slice("finding:".length)}`;
          const previous = byId.get(id);
          const previousStatus = text(previous?.status, 40);
          if (previousStatus === "accepted") {
            migratedDispositions.set(fingerprint, "acknowledged");
          } else if (previousStatus === "dismissed" || previousStatus === "blocked") {
            migratedDispositions.set(fingerprint, previousStatus);
          }
          const previousIssue = asObject(previous?.github_issue) ?? {};
          const report =
            finding.markdown?.trim().slice(0, 16_000) || finding.summary.trim().slice(0, 4_000);
          const record: JsonObject = {
            ...previous,
            id,
            source: "code_review",
            profile: "t3-random-codebase-review",
            title,
            description: finding.summary.trim().slice(0, 4_000) || title,
            status: text(previous?.status, 40) ?? "pending",
            created_at: text(previous?.created_at, 100) ?? createdAt,
            expires_at: text(previous?.expires_at, 100) ?? expiresAt,
            repository: {
              name: input.repository.name.trim().slice(0, 200) || "Unknown repository",
              path: input.repository.path.trim().slice(0, 1_000),
              ...(input.repository.githubRepo
                ? { github_repo: input.repository.githubRepo.trim().slice(0, 250) }
                : {}),
            },
            category: finding.category.trim().slice(0, 40) || "insight",
            impact: finding.impact.trim().slice(0, 1_200),
            confidence: finding.confidence.trim().slice(0, 40) || "medium",
            evidence: finding.evidence.slice(0, 24).map((item) => item.trim().slice(0, 1_000)),
            next_step: finding.nextStep.trim().slice(0, 1_200),
            report,
            github_issue: {
              ...previousIssue,
              title: finding.githubIssueTitle.trim().slice(0, 300) || title,
              body: finding.githubIssueBody.trim().slice(0, 16_000) || report,
              url: text(previousIssue.url, 2_000),
              number: previousIssue.number ?? null,
            },
            job_id: input.jobId.trim().slice(0, 200),
          };
          byId.set(id, record);
          canonicalInputs.push(canonicalInput);
          changed += 1;
        }

        await writeAtomic(
          suggestionsPath,
          JSON.stringify({ suggestions: [...byId.values()], updated_at: createdAt }, null, 2),
        );
        await mergeCanonicalFindings(canonicalInputs);
        if (migratedDispositions.size > 0) {
          const canonicalFindings = await readCanonicalFindingsRaw();
          let dispositionChanged = false;
          const migrated = canonicalFindings.map((finding) => {
            const state = migratedDispositions.get(finding.fingerprint);
            if (!state || finding.disposition.state !== "open") return finding;
            dispositionChanged = true;
            return {
              ...finding,
              disposition: {
                ...finding.disposition,
                state,
                updatedAt: createdAt,
                actor: "legacy-migration",
                note: "Migrated from the legacy review suggestion state.",
              },
            };
          });
          if (dispositionChanged) {
            await writeDocumentArray(
              findingsPath,
              "findings",
              migrated.map((finding) => finding as unknown as JsonObject),
            );
          }
        }
        return changed;
      }),
    );

  const reviewSuggestion = (id: string, action: "dismiss" | "block") =>
    run("review suggestion", () =>
      withMutation(async () => {
        const target = await readReviewSuggestionRaw();
        const byId = new Map<string, JsonObject>();
        for (const record of target) {
          const recordId = text(record.id, 100);
          if (recordId) byId.set(recordId, record);
        }
        const record = byId.get(id);
        if (!record || record.source !== "code_review") return false;
        record.status = action === "block" ? "blocked" : "dismissed";
        record.resolved_at = new Date().toISOString();
        await writeAtomic(
          suggestionsPath,
          JSON.stringify(
            { suggestions: [...byId.values()], updated_at: new Date().toISOString() },
            null,
            2,
          ),
        );
        return true;
      }),
    );

  const appendExternalActionInternal = async (
    action: AgentDashboardExternalAction,
  ): Promise<void> => {
    const actions = await readDocumentArray(externalActionsPath, "actions");
    const next = [
      action as unknown as JsonObject,
      ...actions.filter((item) => item.id !== action.id),
    ].slice(0, 500);
    await writeDocumentArray(externalActionsPath, "actions", next);
  };

  const createGithubIssue = (
    id: string,
    resolvedGithubRepository: string | null = null,
    githubEnvironment?: NodeJS.ProcessEnv,
  ) =>
    run("create GitHub issue", () =>
      withMutation(async () => {
        const reviewSuggestions = await readReviewSuggestionRaw();
        const record = reviewSuggestions.find((candidate) => text(candidate.id, 100) === id);
        const canonicalFindings = await readCanonicalFindingsRaw();
        const canonical = canonicalFindings.find(
          (finding) => finding.id === id || finding.id === id.replace(/^t3-review-/, "finding:"),
        );
        if ((!record || record.source !== "code_review") && !canonical) {
          throw new Error("Suggestion not found.");
        }
        if (record && String(record.status ?? "pending") !== "pending") {
          throw new Error("Suggestion is no longer pending.");
        }
        if (
          !record &&
          canonical &&
          (canonical.disposition.state === "done" ||
            canonical.disposition.state === "dismissed" ||
            canonical.disposition.state === "blocked")
        ) {
          throw new Error("Finding is no longer actionable.");
        }

        const issue = asObject(record?.github_issue) ?? {};
        const existingUrl = text(issue.url, 2_000) ?? canonical?.externalIssueUrl ?? null;
        if (existingUrl) return true;

        const repository = asObject(record?.repository) ?? {};
        const githubRepository = text(repository.github_repo, 250) ?? resolvedGithubRepository;
        if (!githubRepository || !GITHUB_REPOSITORY_PATTERN.test(githubRepository)) {
          throw new Error("This finding does not have a GitHub repository configured.");
        }

        const canonicalDraft = canonical ? buildCanonicalGithubIssueDraft(canonical) : null;
        const title =
          text(issue.title, 300) ?? text(record?.title, 300) ?? canonicalDraft?.title ?? null;
        const body =
          text(issue.body, 16_000) ?? text(record?.report, 16_000) ?? canonicalDraft?.body ?? null;
        if (!title || !body) throw new Error("This finding does not contain an issue draft.");

        const result = await runExecutable(
          "gh",
          [
            "api",
            `repos/${githubRepository}/issues`,
            "--method",
            "POST",
            "-f",
            `title=${title}`,
            "-f",
            `body=${body}`,
          ],
          {
            timeout: 30_000,
            env: {
              ...process.env,
              ...githubEnvironment,
              GH_PROMPT_DISABLED: "1",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        );
        let payload: JsonObject;
        try {
          const parsed: unknown = JSON.parse(result.stdout);
          payload = asObject(parsed) ?? {};
        } catch {
          throw new Error("GitHub returned an unreadable issue response.");
        }

        const url = text(payload.html_url, 2_000);
        const number = integer(payload.number, 0);
        if (!url || !GITHUB_ISSUE_URL_PATTERN.test(url) || number <= 0) {
          throw new Error("GitHub returned an invalid issue response.");
        }

        if (record) {
          record.github_issue = {
            ...issue,
            title,
            body,
            url,
            number,
          };
          await writeAtomic(
            suggestionsPath,
            JSON.stringify(
              { suggestions: reviewSuggestions, updated_at: new Date().toISOString() },
              null,
              2,
            ),
          );
        }
        if (canonical) {
          await writeDocumentArray(
            findingsPath,
            "findings",
            canonicalFindings.map(
              (finding) =>
                (finding.id === canonical.id
                  ? { ...finding, externalIssueUrl: url }
                  : finding) as unknown as JsonObject,
            ),
          );
        }
        await appendExternalActionInternal({
          id: `action:create-github-issue:${id}`,
          kind: "create-github-issue",
          status: "succeeded",
          actor: "dashboard",
          targetId: String(number),
          targetUrl: url,
          findingId: canonical?.id ?? id,
          runId: canonical?.lastRunId ?? null,
          result: "created",
          occurredAt: new Date().toISOString(),
        });
        return true;
      }),
    );

  const hydrateReviewActionability = async (
    findings: ReadonlyArray<AgentDashboardFinding>,
  ): Promise<Array<AgentDashboardFinding>> => {
    const reviewSuggestions = await readReviewSuggestionRaw();
    const suggestionsByFindingId = new Map<string, JsonObject>();
    const suggestionsByRepositoryTitle = new Map<string, JsonObject>();
    for (const suggestion of reviewSuggestions) {
      if (text(suggestion.source, 120) !== "code_review") continue;
      const id = text(suggestion.id, 100);
      if (id?.startsWith("t3-review-")) {
        suggestionsByFindingId.set(`finding:${id.slice("t3-review-".length)}`, suggestion);
      }
      const repositoryPath = text(asObject(suggestion.repository)?.path, 2_000);
      const title = text(suggestion.title, 300);
      if (repositoryPath && title) {
        suggestionsByRepositoryTitle.set(reviewSuggestionKey(repositoryPath, title), suggestion);
      }
    }

    return findings.map((finding) => {
      if (finding.actionability !== null || finding.provenance.source !== "code_review") {
        return finding;
      }
      const byIdentity = suggestionsByFindingId.get(finding.id);
      const byRepositoryTitle = finding.repositoryPath
        ? suggestionsByRepositoryTitle.get(
            reviewSuggestionKey(finding.repositoryPath, finding.title),
          )
        : undefined;
      const suggestion = byIdentity ?? byRepositoryTitle;
      const actionability = suggestion
        ? reviewFindingActionability(suggestion.next_step, suggestion.impact, {
            type: finding.type,
            category: finding.category,
            qualifiedAt: finding.lastSeenAt,
            occurrenceCount: finding.occurrenceCount,
          })
        : null;
      return actionability ? { ...finding, actionability } : finding;
    });
  };

  const readFindings = run("read canonical findings", async () => {
    const findings = await hydrateReviewActionability(await readCanonicalFindingsRaw());
    return findings.toSorted(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.id.localeCompare(left.id),
    );
  });

  const appendFindings = (inputs: ReadonlyArray<AgentDashboardCanonicalFindingInput>) =>
    run("append canonical findings", () => withMutation(() => mergeCanonicalFindings(inputs)));

  const applyFindingQualifications: AgentDashboardStoreService["applyFindingQualifications"] = (
    inputs,
  ) =>
    run("apply finding qualifications", () =>
      withMutation(async () => {
        const findings = await readCanonicalFindingsRaw();
        const qualifications = new Map(
          inputs
            .map((input) => ({ ...input, id: input.id.trim() }))
            .filter((input) => input.id.length > 0)
            .map((input) => [input.id, input] as const),
        );
        const qualifiedAt = new Date().toISOString();
        let changed = 0;
        const next = findings.map((finding) => {
          const qualification = qualifications.get(finding.id);
          if (!qualification || finding.disposition.state !== "open" || finding.thread !== null) {
            return finding;
          }

          const reason = text(qualification.reason, 1_200) ?? "Qualification completed.";
          changed += 1;
          if (qualification.outcome === "dismiss") {
            return {
              ...finding,
              disposition: {
                ...finding.disposition,
                state: "dismissed" as const,
                updatedAt: qualifiedAt,
                actor: "repository-review",
                note: reason,
                snoozeUntil: null,
              },
            };
          }

          const proposal = text(qualification.proposal, 1_200);
          const expectedValue = text(qualification.expectedValue, 1_200);
          if (!proposal || !expectedValue) {
            changed -= 1;
            return finding;
          }
          return {
            ...finding,
            actionability: {
              readiness:
                finding.category === "product-opportunity"
                  ? ("needs-research" as const)
                  : qualification.outcome,
              proposal,
              expectedValue,
              targets: qualification.targets.slice(0, 24).map((target) => ({
                path: target.path.trim().slice(0, 1_000),
                symbol: target.symbol?.trim().slice(0, 300) || null,
                evidence: target.evidence.trim().slice(0, 1_000),
              })),
              validationPlan: qualification.validationPlan
                .map((item) => item.trim().slice(0, 1_000))
                .filter(Boolean)
                .slice(0, 24),
              sources: qualification.sources.slice(0, 24).map((source) => ({
                title: source.title.trim().slice(0, 300),
                url: source.url.trim().slice(0, 2_000),
                kind: source.kind.trim().slice(0, 120),
              })),
              riskTier: qualification.riskTier,
              estimatedEffort: qualification.estimatedEffort,
              qualificationReason: reason,
              qualifiedAt,
              qualifiedBy: "repository-review",
              qualifiedOccurrenceCount: finding.occurrenceCount,
            },
          };
        });

        if (changed > 0) {
          await writeDocumentArray(
            findingsPath,
            "findings",
            next.map((finding) => finding as unknown as JsonObject),
          );
        }
        return changed;
      }),
    );

  const applyFindingAction = (input: AgentDashboardDispositionActionInput) =>
    run("apply finding action", () =>
      withMutation(async () => {
        const findings = await readCanonicalFindingsRaw();
        const target = findings.find(
          (finding) => finding.id === input.id || finding.fingerprint === input.id,
        );
        const now = new Date().toISOString();
        const nextState = (() => {
          switch (input.action) {
            case "acknowledge":
              return "acknowledged" as const;
            case "snooze":
              return "snoozed" as const;
            case "assign":
              return "assigned" as const;
            case "complete":
              return "done" as const;
            case "dismiss":
              return "dismissed" as const;
            case "block":
              return "blocked" as const;
            case "reopen":
              return "open" as const;
          }
        })();

        if (!target) {
          const legacy = await readReviewSuggestionRaw();
          const legacyTarget = legacy.find((record) => text(record.id, 100) === input.id);
          if (!legacyTarget || legacyTarget.source !== "code_review") return "not-found";
          if (input.action === "dismiss" || input.action === "block") {
            legacyTarget.status = input.action === "block" ? "blocked" : "dismissed";
            legacyTarget.resolved_at = now;
            await writeDocumentArray(suggestionsPath, "suggestions", legacy);
            return "applied";
          }
          return "not-found";
        }

        const snoozeUntil =
          input.action === "snooze"
            ? (input.snoozeUntil ?? new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString())
            : null;
        const nextDisposition = {
          state: nextState,
          updatedAt: now,
          actor: "dashboard",
          note: input.note ?? null,
          snoozeUntil,
          assignee:
            input.action === "assign"
              ? (input.assignee ?? null)
              : input.action === "reopen"
                ? null
                : target.disposition.assignee,
        } satisfies AgentDashboardFinding["disposition"];
        if (
          target.disposition.state === nextDisposition.state &&
          target.disposition.snoozeUntil === nextDisposition.snoozeUntil &&
          target.disposition.assignee === nextDisposition.assignee &&
          target.disposition.note === nextDisposition.note
        ) {
          return "noop";
        }

        const nextFindings = findings.map((finding) =>
          finding.id === target.id ? { ...finding, disposition: nextDisposition } : finding,
        );
        await writeDocumentArray(
          findingsPath,
          "findings",
          nextFindings.map((finding) => finding as unknown as JsonObject),
        );

        const legacy = await readReviewSuggestionRaw();
        const legacyTarget = legacy.find((record) => {
          const legacyId = text(record.id, 100);
          return (
            legacyId === target.id || legacyId === `t3-review-${target.id.replace(/^finding:/, "")}`
          );
        });
        if (legacyTarget && (input.action === "dismiss" || input.action === "block")) {
          legacyTarget.status = input.action === "block" ? "blocked" : "dismissed";
          legacyTarget.resolved_at = now;
          await writeDocumentArray(suggestionsPath, "suggestions", legacy);
        }
        return "applied";
      }),
    );

  const linkFindingThread = (input: AgentDashboardLinkFindingThreadInput) =>
    run("link finding thread", () =>
      withMutation(async () => {
        const findings = await readCanonicalFindingsRaw();
        const legacyCanonicalId = input.id.replace(/^t3-review-/, "finding:");
        const target = findings.find(
          (finding) =>
            finding.id === input.id ||
            finding.fingerprint === input.id ||
            finding.id === legacyCanonicalId,
        );
        if (!target) return "not-found";

        if (target.thread !== null && target.thread.threadId !== input.threadId) {
          return "noop";
        }

        const now = new Date().toISOString();
        const nextThread = { projectId: input.projectId, threadId: input.threadId };
        const nextDisposition = {
          ...target.disposition,
          state: "in-progress" as const,
          updatedAt: now,
          actor: "dashboard",
          note: "Work started from the T3 Code Agent Dashboard.",
          snoozeUntil: null,
        } satisfies AgentDashboardFinding["disposition"];
        const alreadyLinked =
          target.thread?.projectId === nextThread.projectId &&
          target.thread?.threadId === nextThread.threadId;
        if (alreadyLinked && target.disposition.state === "in-progress") return "noop";

        await writeDocumentArray(
          findingsPath,
          "findings",
          findings.map(
            (finding) =>
              (finding.id === target.id
                ? { ...finding, thread: nextThread, disposition: nextDisposition }
                : finding) as unknown as JsonObject,
          ),
        );
        await appendExternalActionInternal({
          id: `action:open-thread:${target.id}:${input.threadId}`,
          kind: "open-thread",
          status: "succeeded",
          actor: "dashboard",
          targetId: input.threadId,
          targetUrl: null,
          findingId: target.id,
          runId: target.lastRunId,
          result: "linked",
          occurredAt: now,
        });
        return "applied";
      }),
    );

  const claimFindingThread = (input: AgentDashboardLinkFindingThreadInput) =>
    run("claim finding thread", () =>
      withMutation(async () => {
        const findings = await readCanonicalFindingsRaw();
        const rawTarget = findings.find(
          (finding) => finding.id === input.id || finding.fingerprint === input.id,
        );
        if (!rawTarget) return "not-found";
        const target = (await hydrateReviewActionability([rawTarget]))[0] ?? rawTarget;
        if (
          target.thread !== null ||
          target.disposition.state !== "open" ||
          target.actionability?.readiness !== "ready"
        ) {
          return "noop";
        }

        const now = new Date().toISOString();
        await writeDocumentArray(
          findingsPath,
          "findings",
          findings.map(
            (finding) =>
              (finding.id === target.id
                ? {
                    ...target,
                    thread: { projectId: input.projectId, threadId: input.threadId },
                    disposition: {
                      ...finding.disposition,
                      state: "in-progress" as const,
                      updatedAt: now,
                      actor: "continuous-improvement",
                      note: "Reserved by Continuous Improvement Mode.",
                      snoozeUntil: null,
                    },
                  }
                : finding) as unknown as JsonObject,
          ),
        );
        return "applied";
      }),
    );

  const releaseFindingThread = (input: AgentDashboardLinkFindingThreadInput) =>
    run("release finding thread", () =>
      withMutation(async () => {
        const findings = await readCanonicalFindingsRaw();
        const target = findings.find(
          (finding) => finding.id === input.id || finding.fingerprint === input.id,
        );
        if (!target) return "not-found";
        if (target.thread?.threadId !== input.threadId) return "noop";

        const now = new Date().toISOString();
        await writeDocumentArray(
          findingsPath,
          "findings",
          findings.map(
            (finding) =>
              (finding.id === target.id
                ? {
                    ...finding,
                    thread: null,
                    disposition: {
                      ...finding.disposition,
                      state: "open" as const,
                      updatedAt: now,
                      actor: "continuous-improvement",
                      note: "Automatic implementation launch failed and was released for retry.",
                      snoozeUntil: null,
                    },
                  }
                : finding) as unknown as JsonObject,
          ),
        );
        return "applied";
      }),
    );

  const resolveStaleFindingReservation = (input: AgentDashboardStaleFindingResolutionInput) =>
    run("resolve stale finding reservation", () =>
      withMutation(async () => {
        const findings = await readCanonicalFindingsRaw();
        const target = findings.find(
          (finding) => finding.id === input.id || finding.fingerprint === input.id,
        );
        if (!target) return "not-found";

        const reason = text(input.reason, 1_000);
        const ownsReservation =
          isContinuousImprovementFindingReservation(target) &&
          target.thread?.projectId === input.projectId &&
          target.thread.threadId === input.threadId;
        if (!reason || !ownsReservation) return "noop";

        const now = new Date().toISOString();
        const note = `Automatic implementation agent confirmed this finding is stale: ${reason}`;
        await writeDocumentArray(
          findingsPath,
          "findings",
          findings.map(
            (finding) =>
              (finding.id === target.id
                ? {
                    ...finding,
                    thread: null,
                    disposition: {
                      ...finding.disposition,
                      state: "dismissed" as const,
                      updatedAt: now,
                      actor: "continuous-improvement",
                      note,
                      snoozeUntil: null,
                    },
                  }
                : finding) as unknown as JsonObject,
          ),
        );

        const legacy = await readReviewSuggestionRaw();
        const legacyTarget = legacy.find((record) => {
          const legacyId = text(record.id, 100);
          return (
            legacyId === target.id || legacyId === `t3-review-${target.id.replace(/^finding:/, "")}`
          );
        });
        if (legacyTarget) {
          legacyTarget.status = "dismissed";
          legacyTarget.resolved_at = now;
          await writeDocumentArray(suggestionsPath, "suggestions", legacy);
        }
        return "applied";
      }),
    );

  const readRepositoryPolicies = run("read repository policies", async () =>
    (await readDocumentArray(policiesPath, "policies"))
      .map(decodePolicy)
      .filter((value): value is AgentDashboardRepositoryPolicy => value !== null),
  );

  const readRepositoryPoliciesRaw = async (): Promise<Array<JsonObject>> =>
    readDocumentArray(policiesPath, "policies");

  const writeRepositoryPolicy = (policy: AgentDashboardRepositoryPolicy) =>
    run("write repository policy", () =>
      withMutation(async () => {
        const policies = await readRepositoryPoliciesRaw();
        const byRepository = new Map(
          policies.map(
            (item) =>
              [
                String(asObject(item.repository)?.projectId ?? NodeCrypto.randomUUID()),
                item,
              ] as const,
          ),
        );
        byRepository.set(String(policy.repository.projectId), policy as unknown as JsonObject);
        await writeDocumentArray(policiesPath, "policies", [...byRepository.values()]);
        return true;
      }),
    );

  const readRepositoryCoverage = run("read repository coverage", async () =>
    (await readDocumentArray(coveragePath, "coverage"))
      .map(decodeCoverage)
      .filter((value): value is AgentDashboardRepositoryCoverage => value !== null),
  );

  const recordAutomationRun = (runRecord: AgentDashboardAutomationRun) =>
    run("record automation run coverage", () =>
      withMutation(async () => {
        // Repository coverage drives the read-only review scheduler. Runs from
        // other automation kinds share the same history file but must not move
        // review due dates or failure backoff.
        if (runRecord.kind !== "repository-review") return;
        const projectId = String(runRecord.repository.projectId);
        if (!projectId || projectId === "pending-selection") return;
        const now = runRecord.updatedAt;
        const coverage = await readDocumentArray(coveragePath, "coverage");
        const policies = await readRepositoryPoliciesRaw();
        const policy = policies
          .map(decodePolicy)
          .find((item) => item !== null && String(item.repository.projectId) === projectId);
        const cadenceMinutes = policy?.cadenceMinutes ?? 120;
        const existing = coverage
          .map(decodeCoverage)
          .find((item) => item !== null && String(item.repository.projectId) === projectId);
        const terminal =
          runRecord.status === "succeeded" ||
          runRecord.status === "partial" ||
          runRecord.status === "failed" ||
          runRecord.status === "cancelled";
        const successful = runRecord.status === "succeeded" || runRecord.status === "partial";
        const duplicateTerminal = terminal && existing?.lastTerminalRunId === runRecord.id;
        const failures = successful
          ? 0
          : (existing?.consecutiveFailures ?? 0) + (terminal && !duplicateTerminal ? 1 : 0);
        const backoffMinutes = Math.min(7 * 24 * 60, cadenceMinutes * 2 ** Math.min(failures, 6));
        const nextDueAt =
          terminal && !duplicateTerminal
            ? new Date(
                Date.parse(now) + (successful ? cadenceMinutes : backoffMinutes) * 60_000,
              ).toISOString()
            : (existing?.nextDueAt ?? null);
        const next: AgentDashboardRepositoryCoverage = {
          repository: { projectId: ProjectId.make(projectId) },
          status: successful ? "current" : terminal ? "failing" : (existing?.status ?? "due"),
          lastAttemptedAt: terminal ? now : (existing?.lastAttemptedAt ?? now),
          lastSucceededAt: successful ? now : (existing?.lastSucceededAt ?? null),
          nextDueAt,
          consecutiveFailures: Math.max(0, failures),
          lastError: successful ? null : terminal ? runRecord.error : (existing?.lastError ?? null),
          lastRunId: runRecord.id,
          lastTerminalRunId: terminal
            ? existing?.lastTerminalRunId === runRecord.id
              ? existing.lastTerminalRunId
              : runRecord.id
            : (existing?.lastTerminalRunId ?? null),
          observedAt: now,
        };
        const byRepository = new Map(
          coverage.map((item) => {
            const decoded = decodeCoverage(item);
            return decoded
              ? ([String(decoded.repository.projectId), item] as const)
              : ([NodeCrypto.randomUUID(), item] as const);
          }),
        );
        byRepository.set(projectId, next as unknown as JsonObject);
        await writeDocumentArray(coveragePath, "coverage", [...byRepository.values()]);
      }),
    );

  const repairRepositoryCoverage = (runRecords: ReadonlyArray<AgentDashboardAutomationRun>) =>
    run("repair repository coverage", () =>
      withMutation(async () => {
        const rawCoverage = await readDocumentArray(coveragePath, "coverage");
        const existingCoverage = rawCoverage
          .map(decodeCoverage)
          .filter((item): item is AgentDashboardRepositoryCoverage => item !== null);
        const policies = (await readRepositoryPoliciesRaw())
          .map(decodePolicy)
          .filter((item): item is AgentDashboardRepositoryPolicy => item !== null);
        const policyByProject = new Map(
          policies.map((policy) => [String(policy.repository.projectId), policy]),
        );
        const terminalById = new Map<string, AgentDashboardAutomationRun>();
        for (const runRecord of runRecords) {
          if (
            runRecord.kind !== "repository-review" ||
            runRecord.repository.projectId === ProjectId.make("pending-selection") ||
            !["succeeded", "partial", "failed", "cancelled"].includes(runRecord.status)
          ) {
            continue;
          }
          const previous = terminalById.get(runRecord.id);
          if (!previous || Date.parse(runRecord.updatedAt) >= Date.parse(previous.updatedAt)) {
            terminalById.set(runRecord.id, runRecord);
          }
        }
        const runsByProject = new Map<string, Array<AgentDashboardAutomationRun>>();
        for (const runRecord of terminalById.values()) {
          const projectId = String(runRecord.repository.projectId);
          const current = runsByProject.get(projectId) ?? [];
          current.push(runRecord);
          runsByProject.set(projectId, current);
        }

        const now = new Date().toISOString();
        const repaired = existingCoverage.map((existing) => {
          const projectId = String(existing.repository.projectId);
          const terminalRuns = (runsByProject.get(projectId) ?? []).toSorted(
            (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
          );
          if (terminalRuns.length === 0) {
            const contaminated =
              existing.lastRunId?.startsWith("implementation:") === true ||
              existing.consecutiveFailures > 64;
            return contaminated
              ? {
                  ...existing,
                  status: "due" as const,
                  lastAttemptedAt: null,
                  lastSucceededAt: null,
                  nextDueAt: null,
                  consecutiveFailures: 0,
                  lastError: null,
                  lastRunId: null,
                  lastTerminalRunId: null,
                  observedAt: now,
                }
              : existing;
          }

          let failures = 0;
          let lastSucceededAt: string | null = null;
          for (const terminalRun of terminalRuns) {
            if (terminalRun.status === "succeeded" || terminalRun.status === "partial") {
              failures = 0;
              lastSucceededAt = terminalRun.updatedAt;
            } else {
              failures += 1;
            }
          }
          const lastRun = terminalRuns[terminalRuns.length - 1]!;
          const successful = lastRun.status === "succeeded" || lastRun.status === "partial";
          const cadenceMinutes = policyByProject.get(projectId)?.cadenceMinutes ?? 120;
          const backoffMinutes = Math.min(7 * 24 * 60, cadenceMinutes * 2 ** Math.min(failures, 6));
          return {
            repository: { projectId: ProjectId.make(projectId) },
            status: successful ? ("current" as const) : ("failing" as const),
            lastAttemptedAt: lastRun.updatedAt,
            lastSucceededAt,
            nextDueAt: new Date(
              Date.parse(lastRun.updatedAt) +
                (successful ? cadenceMinutes : backoffMinutes) * 60_000,
            ).toISOString(),
            consecutiveFailures: failures,
            lastError: successful ? null : lastRun.error,
            lastRunId: lastRun.id,
            lastTerminalRunId: lastRun.id,
            observedAt: lastRun.updatedAt,
          } satisfies AgentDashboardRepositoryCoverage;
        });
        if (JSON.stringify(existingCoverage) !== JSON.stringify(repaired)) {
          await writeDocumentArray(coveragePath, "coverage", repaired as unknown as JsonObject[]);
        }
      }),
    );

  const readExternalActions = run("read external action audit", async () =>
    (await readDocumentArray(externalActionsPath, "actions"))
      .map(decodeExternalAction)
      .filter((value): value is AgentDashboardExternalAction => value !== null)
      .toSorted((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)),
  );

  const appendExternalAction = (action: AgentDashboardExternalAction) =>
    run("append external action audit", () =>
      withMutation(() => appendExternalActionInternal(action)),
    );

  const readCollectorStates = run("read collector states", async () =>
    (await readDocumentArray(collectorStatesPath, "collectors"))
      .map(decodeCollectorState)
      .filter((value): value is AgentDashboardCollectorState => value !== null)
      .toSorted((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)),
  );

  const writeCollectorState = (state: AgentDashboardCollectorState) =>
    run("write collector state", () =>
      withMutation(async () => {
        const states = await readDocumentArray(collectorStatesPath, "collectors");
        const next = [
          state as unknown as JsonObject,
          ...states.filter((item) => item.id !== state.id),
        ].slice(0, 200);
        await writeDocumentArray(collectorStatesPath, "collectors", next);
      }),
    );

  const feedToken = run("read feed token", async () => {
    const configured = process.env.T3_AGENT_FEED_TOKEN?.trim();
    if (configured) return configured;
    return (await NodeFSP.readFile(tokenPath, "utf8")).trim();
  });

  return {
    readFeed,
    appendFeed,
    dismissFeedCard,
    clearFeed,
    readFeedImage,
    readResearchFindings,
    upsertResearchWatchItem,
    readReviewSuggestions,
    appendReviewSuggestions,
    reviewSuggestion,
    createGithubIssue,
    readFindings,
    appendFindings,
    applyFindingQualifications,
    applyFindingAction,
    linkFindingThread,
    claimFindingThread,
    releaseFindingThread,
    resolveStaleFindingReservation,
    readRepositoryPolicies,
    writeRepositoryPolicy,
    readRepositoryCoverage,
    recordAutomationRun,
    repairRepositoryCoverage,
    readExternalActions,
    appendExternalAction,
    readCollectorStates,
    writeCollectorState,
    feedToken,
  } satisfies AgentDashboardStoreService;
};

const stores = new Map<string, AgentDashboardStoreService>();

/** Returns the process-wide store for a server state directory. */
export const getStore = (stateDir: string): AgentDashboardStoreService => {
  const existing = stores.get(stateDir);
  if (existing) return existing;
  const store = makeStore(stateDir);
  stores.set(stateDir, store);
  return store;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return getStore(config.stateDir);
});

export const layer = Layer.effect(AgentDashboardStore, make);
