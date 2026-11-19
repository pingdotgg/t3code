import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2MessageProvenance,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ApplicationProjectEvent,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { messageProvenance } from "@t3tools/provider-core/server/messageProvenance";
// @effect-diagnostics nodeBuiltinImport:off - realpath plus inode identity is how a case variant or a symlink is the same directory
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../src/orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as HolographicMemory from "../src/project/knowledge/HolographicMemory.ts";
import * as ProjectKnowledge from "../src/project/knowledge/ProjectKnowledge.ts";

const KNOWLEDGE_ALLOWANCE = 48_000;
const RECALL_TIMEOUT = "1 second";
const GATES = [
  "hand_picked",
  "slash",
  "progress_notice",
  "nonhuman",
  "current_correction",
  "scratch_project",
  "allowance",
  "kernel_unavailable",
  "no_match",
  "resolve_failed",
  "delivered",
  "failed",
  "timeout",
] as const;

const environmentId = EnvironmentId.make("project-memory-replay");
const providerInstanceId = ProviderInstanceId.make("replay");
const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 16));

export interface ReplayOptions {
  readonly facts: string;
  readonly messages: string;
  readonly out: string;
  readonly project?: string;
  /** Canonical managed scratch project ID; the message export contains no workspace roots. */
  readonly scratchProject?: string;
  readonly factCount?: number;
  readonly limit?: number;
  readonly candidateLimit?: number;
}

interface NormalizedFact {
  readonly id: string;
  readonly projectId: string;
  readonly content: string;
  readonly entities: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly originThread: string | null;
  readonly trust: number | null;
  readonly createdAt: string | null;
}

interface NormalizedMessage {
  readonly messageId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly createdBy: string;
  readonly text: string;
  readonly notification?: OrchestrationV2ConversationMessage["notification"];
  readonly delegatedCompletion?: OrchestrationV2ConversationMessage["delegatedCompletion"];
  readonly provenance?: OrchestrationV2MessageProvenance;
  readonly noticeKind: string | null;
}

export interface ReplayRow {
  readonly messageId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly createdBy: string;
  readonly noticeKind: string | null;
  readonly characters: number;
  readonly gate: string;
  readonly deliveredFactIds: ReadonlyArray<string>;
  readonly top: ReadonlyArray<{ readonly factId: string }>;
  readonly wallMs: number;
  readonly candidatesMs: number | null;
  readonly scoringMs: number | null;
  readonly statsMs: number | null;
  readonly resolveMs: number | null;
  readonly seenMs: number | null;
}

interface Distribution {
  readonly n: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

const directoryIdentity = (file: string) => {
  try {
    const stat = NodeFS.statSync(file);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
};

const nearestExisting = (path: Path.Path, file: string) => {
  let current = path.resolve(file);
  while (directoryIdentity(current) === null) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return NodeFS.realpathSync(current);
};

const resolvesInside = (path: Path.Path, file: string, root: string) => {
  const rootIdentity = directoryIdentity(root);
  if (rootIdentity === null) return false;
  let current = nearestExisting(path, file);
  while (true) {
    const identity = directoryIdentity(current);
    if (identity !== null && identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino)
      return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

const assertReplayPath = (path: Path.Path, file: string) => {
  const roots = [path.join(NodeOS.homedir(), ".t3", "userdata")];
  if (process.env.T3CODE_HOME)
    roots.push(path.join(path.resolve(process.env.T3CODE_HOME), "userdata"));
  for (const root of roots) {
    if (resolvesInside(path, file, root))
      throw new Error(`Refusing to touch live T3 data at ${path.resolve(file)}`);
  }
};

const parseJsonArray = (text: string): unknown[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
  return parsed;
};

const encodeJson = (value: unknown) => JSON.stringify(value);
const encodePretty = (value: unknown) => JSON.stringify(value, null, 2);

const positiveInteger = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const parseReplayArgs = (argv: ReadonlyArray<string>): ReplayOptions => {
  const read = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  };
  const factsPath = read("--facts");
  const messagesPath = read("--messages");
  const out = read("--out");
  if (!factsPath || !messagesPath || !out)
    throw new Error(
      "Usage: replay-project-memory.ts --facts <facts.json> --messages <msgs.json> --out <dir> [--project <id>] [--scratch-project <canonical-id>] [--fact-count <n>] [--limit <n>] [--candidate-limit <n>]",
    );
  const project = read("--project");
  const scratchProject = read("--scratch-project");
  const factCount = positiveInteger("--fact-count", read("--fact-count"));
  const limit = positiveInteger("--limit", read("--limit"));
  const candidateLimit = positiveInteger("--candidate-limit", read("--candidate-limit"));
  return {
    facts: factsPath,
    messages: messagesPath,
    out,
    ...(project ? { project } : {}),
    ...(scratchProject ? { scratchProject } : {}),
    ...(factCount === undefined ? {} : { factCount }),
    ...(limit === undefined ? {} : { limit }),
    ...(candidateLimit === undefined ? {} : { candidateLimit }),
  };
};

const labels = (value: unknown, field: string): ReadonlyArray<string> => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
  return parsed
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => item.slice(0, 200))
    .slice(0, 32);
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const normalizeFact = (value: unknown): NormalizedFact => {
  const row = asRecord(value, "fact");
  const content = typeof row.content === "string" ? row.content.trim() : "";
  if (typeof row.id !== "string" || row.id.trim() === "") throw new Error("fact id is missing");
  if (typeof row.project_id !== "string" || row.project_id.trim() === "")
    throw new Error(`fact ${row.id} has no project_id`);
  if (content === "" || content.length > 12_000)
    throw new Error(`fact ${row.id} content is empty or longer than 12000 characters`);
  const trust = row.trust === undefined || row.trust === null ? null : Number(row.trust);
  if (trust !== null && (!Number.isFinite(trust) || trust < 0 || trust > 1))
    throw new Error(`fact ${row.id} trust is not between 0 and 1`);
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  const origin =
    typeof row.origin_thread === "string" && row.origin_thread.trim() !== ""
      ? row.origin_thread
      : null;
  return {
    id: row.id,
    projectId: row.project_id,
    content,
    entities: labels(row.entities_json ?? "[]", `${row.id} entities_json`),
    tags: labels(row.tags_json ?? "[]", `${row.id} tags_json`),
    originThread: origin,
    trust,
    createdAt,
  };
};

const decodeMessageMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    ...OrchestrationV2MessageProvenance.fields,
    notification: OrchestrationV2ConversationMessage.fields.notification,
    delegatedCompletion: OrchestrationV2ConversationMessage.fields.delegatedCompletion,
    scheduledTaskId: OrchestrationV2ConversationMessage.fields.scheduledTaskId,
  }),
);

const normalizeMessage = (value: unknown): NormalizedMessage => {
  const row = asRecord(value, "message");
  if (typeof row.message_id !== "string" || row.message_id.trim() === "")
    throw new Error("message_id is missing");
  if (typeof row.project_id !== "string" || typeof row.thread_id !== "string")
    throw new Error(`message ${row.message_id} is missing project_id or thread_id`);
  const payload =
    typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
  const body =
    typeof payload === "object" && payload !== null ? asRecord(payload, "payload_json") : row;
  const rawActor = body.createdBy ?? row.created_by ?? row.createdBy;
  const createdBy = typeof rawActor === "string" ? rawActor : "unknown";
  const text =
    typeof row.text === "string" ? row.text : typeof body.text === "string" ? body.text : "";
  const metadata = decodeMessageMetadata({
    createdBy: createdBy === "user" || createdBy === "agent" ? createdBy : "system",
    creationSource: body.creationSource ?? row.creation_source ?? row.creationSource ?? "server",
    senderThreadId: body.senderThreadId ?? row.sender_thread_id ?? row.senderThreadId ?? undefined,
    linkedSender: body.linkedSender ?? row.linkedSender ?? undefined,
    notification: body.notification ?? row.notification ?? undefined,
    delegatedCompletion: body.delegatedCompletion ?? row.delegatedCompletion ?? undefined,
    scheduledTaskId: body.scheduledTaskId ?? row.scheduledTaskId ?? undefined,
  });
  const provenance = messageProvenance(metadata);
  return {
    messageId: row.message_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    createdBy,
    text,
    ...(metadata.notification === undefined ? {} : { notification: metadata.notification }),
    ...(metadata.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: metadata.delegatedCompletion }),
    ...(provenance === undefined ? {} : { provenance }),
    noticeKind: metadata.notification?.source.kind ?? null,
  };
};

const scaleFacts = (
  facts: ReadonlyArray<NormalizedFact>,
  count: number,
): ReadonlyArray<NormalizedFact> => {
  const sorted = [...facts].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (count <= sorted.length) return sorted.slice(0, count);
  if (sorted.length === 0) throw new Error("Cannot scale an empty fact corpus");
  const scaled = [...sorted];
  let copy = 1;
  while (scaled.length < count) {
    for (const fact of sorted) {
      if (scaled.length >= count) break;
      scaled.push({ ...fact, id: `replay-copy:${copy}:${fact.id}` });
    }
    copy += 1;
  }
  return scaled;
};

const selectCorpus = (
  facts: ReadonlyArray<NormalizedFact>,
  messages: ReadonlyArray<NormalizedMessage>,
  options: ReplayOptions,
): {
  readonly facts: ReadonlyArray<NormalizedFact>;
  readonly messages: ReadonlyArray<NormalizedMessage>;
  readonly project: string | null;
  readonly factScale: "as-exported" | "sample" | "duplicate";
} => {
  const project =
    options.project ??
    (options.factCount === undefined
      ? null
      : ([
          ...facts.reduce(
            (counts, fact) => counts.set(fact.projectId, (counts.get(fact.projectId) ?? 0) + 1),
            new Map<string, number>(),
          ),
        ].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))[0]?.[0] ??
        null));
  const inProject = project === null ? facts : facts.filter((fact) => fact.projectId === project);
  if (project !== null && inProject.length === 0)
    throw new Error(`No facts for project ${project}`);
  const scaled =
    options.factCount === undefined ? inProject : scaleFacts(inProject, options.factCount);
  const factScale =
    options.factCount === undefined
      ? "as-exported"
      : options.factCount < inProject.length
        ? "sample"
        : options.factCount > inProject.length
          ? "duplicate"
          : "as-exported";
  const projectMessages =
    project === null ? messages : messages.filter((message) => message.projectId === project);
  const limited =
    options.limit === undefined ? projectMessages : projectMessages.slice(0, options.limit);
  return { facts: scaled, messages: limited, project, factScale };
};

const distribution = (values: ReadonlyArray<number>): Distribution => {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile: number) =>
    sorted.length === 0
      ? null
      : sorted[
          Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
          )
        ]!;
  return { n: sorted.length, p50: at(50), p90: at(90), p99: at(99), max: sorted.at(-1) ?? null };
};

const exceeded = (values: ReadonlyArray<number>) => ({
  "150": values.filter((ms) => ms > 150).length,
  "300": values.filter((ms) => ms > 300).length,
  "500": values.filter((ms) => ms > 500).length,
  "1000": values.filter((ms) => ms > 1000).length,
});

const emptyGates = (): Record<string, number> => Object.fromEntries(GATES.map((gate) => [gate, 0]));

export const summarizeReplay = (
  rows: ReadonlyArray<ReplayRow>,
  meta: {
    readonly factsLoaded: number;
    readonly factScale: "as-exported" | "sample" | "duplicate";
    readonly project: string | null;
    readonly scratchProject: string | null;
    readonly knowledgeAllowance: number;
    readonly recallTimeout: string;
    readonly citation: string;
    readonly warmupExcluded: number;
  },
) => {
  const byGate = emptyGates();
  const byCreatedBy: Record<string, { messages: number; byGate: Record<string, number> }> = {};
  for (const row of rows) {
    byGate[row.gate] = (byGate[row.gate] ?? 0) + 1;
    const bucket = byCreatedBy[row.createdBy] ?? { messages: 0, byGate: {} };
    bucket.messages += 1;
    bucket.byGate[row.gate] = (bucket.byGate[row.gate] ?? 0) + 1;
    byCreatedBy[row.createdBy] = bucket;
  }
  const lookup = rows.filter((row) => row.candidatesMs !== null);
  const stage = (pick: (row: ReplayRow) => number | null) =>
    distribution(
      lookup.flatMap((row) => {
        const value = pick(row);
        return value === null ? [] : [value];
      }),
    );
  const walls = rows.map((row) => row.wallMs);
  const lookupWalls = lookup.map((row) => row.wallMs);
  return {
    ...meta,
    messages: rows.length,
    percentile: "nearest-rank ceil(p/100*n)-1",
    byGate,
    byCreatedBy,
    latencyMs: distribution(walls),
    lookupLatencyMs: distribution(lookupWalls),
    exceededMs: { all: exceeded(walls), lookup: exceeded(lookupWalls) },
    stageMs: {
      candidates: stage((row) => row.candidatesMs),
      scoring: stage((row) => row.scoringMs),
      stats: stage((row) => row.statsMs),
      resolve: stage((row) => row.resolveMs),
      seen: stage((row) => row.seenMs),
    },
  };
};

const knowledgeLayer = (dbPath: string) =>
  ProjectKnowledge.layer.pipe(
    Layer.provide(HolographicMemory.layer),
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
    ),
    Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const projectEvent = (projectId: ProjectId): ApplicationProjectEvent => ({
  sequence: 0,
  eventId: EventId.make(`created:${projectId}`),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: DateTime.formatIso(at),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.created",
  payload: {
    projectId,
    title: projectId,
    workspaceRoot: `/replay/${projectId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: DateTime.formatIso(at),
    updatedAt: DateTime.formatIso(at),
  },
});

const threadEvent = (threadId: ThreadId, projectId: ProjectId): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "replay" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const messageEvent = (
  threadId: ThreadId,
  id: string,
  text: string,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});

const spans: Array<{ name: string; ms: number }> = [];
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    span.end = (endTime, exit) => {
      end(endTime, exit);
      spans.push({ name: span.name, ms: Number(endTime - options.startTime) / 1e6 });
    };
    return span;
  },
});

const stageMs = (name: string): number | null => {
  const found = spans.filter((span) => span.name === name);
  if (found.length === 0) return null;
  return found.reduce((sum, span) => sum + span.ms, 0);
};

const recallGate = (outcome: ProjectKnowledge.RecallOutcome): (typeof GATES)[number] => {
  switch (outcome._tag) {
    case "Attached":
      return "delivered";
    case "Omitted":
      return outcome.reason === "timed_out" ? "timeout" : "failed";
    case "Skipped":
      switch (outcome.reason) {
        case "slash":
          return "slash";
        case "hand_attached":
          return "hand_picked";
        case "progress_notice":
          return "progress_notice";
        case "nonhuman":
        case "current_correction":
        case "scratch_project":
          return outcome.reason;
        case "no_budget":
          return "allowance";
        case "no_match":
          return "no_match";
      }
  }
};

const deliveredFactIds = (outcome: ProjectKnowledge.RecallOutcome): Array<string> => {
  if (outcome._tag !== "Attached") return [];
  return outcome.composer.records.flatMap((record) => {
    if (record.kind !== "project-knowledge" || !("knowledge" in record)) return [];
    const knowledge = record.knowledge as {
      selections: ReadonlyArray<{ kind: string; factId?: string }>;
    };
    return knowledge.selections.flatMap((selection) =>
      selection.kind === "fact" && selection.factId ? [selection.factId] : [],
    );
  });
};

const stamp = (value: string | null): string | null => {
  if (value === null) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
};

const loadFacts = Effect.fn("replay.loadFacts")(function* (
  facts: ReadonlyArray<NormalizedFact>,
  messageProjects: ReadonlyArray<string>,
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  const sql = yield* SqlClient.SqlClient;
  const projectIds = [...new Set([...facts.map((fact) => fact.projectId), ...messageProjects])];
  for (const id of projectIds) yield* projects.apply(projectEvent(ProjectId.make(id)));
  const byProject = new Map<string, Array<NormalizedFact>>();
  for (const fact of facts) {
    const group = byProject.get(fact.projectId) ?? [];
    group.push(fact);
    byProject.set(fact.projectId, group);
  }
  const stamps: Array<{ id: string; projectId: string; createdAt: string | null; trust: number }> =
    [];
  for (const [projectId, group] of byProject) {
    const citeThread = ThreadId.make(`replay-cite:${projectId}`);
    const citeMessage = `replay-cite-message:${projectId}`;
    yield* projections.apply(threadEvent(citeThread, ProjectId.make(projectId)));
    yield* projections.apply(messageEvent(citeThread, citeMessage, "Replay citation."));
    const source = yield* knowledge.readSource({
      projectId: ProjectId.make(projectId),
      threadId: citeThread,
      messageId: MessageId.make(citeMessage),
    });
    if (source.state !== "available") return yield* Effect.die("replay citation did not resolve");
    for (const fact of group) {
      const originThread = fact.originThread ?? citeThread;
      yield* knowledge.mutate(
        {
          action: "create",
          commandId: CommandId.make(`create:${fact.id}`),
          projectId: ProjectId.make(projectId),
          factId: ProjectFactId.make(fact.id),
          content: fact.content,
          entities: [...fact.entities],
          tags: [...fact.tags],
          kind: "note",
          sources: [source.source],
        },
        {
          kind: "assisted",
          threadId: ThreadId.make(originThread),
          runId: RunId.make(`replay-run:${projectId}`),
          runOutcome: "completed",
        },
      );
      stamps.push({
        id: fact.id,
        projectId,
        createdAt: stamp(fact.createdAt),
        trust: fact.trust ?? 0.5,
      });
    }
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const fact of stamps) {
        if (fact.createdAt === null && fact.trust === 0.5) continue;
        if (fact.createdAt === null) {
          yield* sql`UPDATE project_knowledge_facts SET trust = ${fact.trust} WHERE id = ${fact.id} AND project_id = ${fact.projectId}`;
        } else {
          yield* sql`UPDATE project_knowledge_facts SET created_at = ${fact.createdAt}, updated_at = ${fact.createdAt}, trust = ${fact.trust} WHERE id = ${fact.id} AND project_id = ${fact.projectId}`;
        }
      }
    }),
  );
  return facts.length;
});

const measureMessage = Effect.fn("replay.measureMessage")(function* (
  message: NormalizedMessage,
  candidateLimit: number | undefined,
  scratchProject: string | undefined,
) {
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  spans.length = 0;
  const started = performance.now();
  const outcome = yield* knowledge
    .recall({
      projectId: ProjectId.make(message.projectId),
      threadId: ThreadId.make(message.threadId),
      requestId: CommandId.make(`memory-recall:${message.messageId}`),
      query: message.text,
      ...(message.notification === undefined ? {} : { notification: message.notification }),
      ...(message.delegatedCompletion === undefined
        ? {}
        : { delegatedCompletion: message.delegatedCompletion }),
      ...(message.provenance === undefined ? {} : { provenance: message.provenance }),
      scratchProject: message.projectId === scratchProject,
      ...(candidateLimit === undefined ? {} : { candidateLimit }),
      composer: { text: message.text, records: [] },
      knowledgeAllowance: KNOWLEDGE_ALLOWANCE,
    })
    .pipe(Effect.provideService(Tracer.Tracer, tracer));
  const wallMs = performance.now() - started;
  const row: ReplayRow = {
    messageId: message.messageId,
    projectId: message.projectId,
    threadId: message.threadId,
    createdBy: message.createdBy,
    noticeKind: message.noticeKind,
    characters: message.text.length,
    gate: recallGate(outcome),
    deliveredFactIds: deliveredFactIds(outcome),
    top: outcome._tag === "Omitted" ? [] : (outcome.top ?? []),
    wallMs,
    candidatesMs:
      stageMs("ProjectKnowledgeStore.recallCandidates") ??
      stageMs("ProjectKnowledgeStore.candidates"),
    scoringMs: stageMs("HolographicMemory.scoreCandidates"),
    statsMs: stageMs("ProjectKnowledgeStore.termStats"),
    resolveMs:
      stageMs("ProjectKnowledge.resolveForTurn") ?? stageMs("ProjectKnowledge.resolveMatches"),
    seenMs: stageMs("ProjectKnowledgeStore.seenFactIds"),
  };
  return row;
});

export const replayProjectMemory = Effect.fn("replay.projectMemory")(function* (
  options: ReplayOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of [options.facts, options.messages, options.out]) assertReplayPath(path, file);
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-replay-" });
  const dbPath = path.join(directory, "state.sqlite");
  assertReplayPath(path, dbPath);
  const facts = parseJsonArray(yield* fs.readFileString(options.facts)).map(normalizeFact);
  const messages = parseJsonArray(yield* fs.readFileString(options.messages)).map(normalizeMessage);
  const corpus = selectCorpus(facts, messages, options);
  const produced = yield* Effect.gen(function* () {
    const loaded = yield* loadFacts(
      corpus.facts,
      corpus.messages.map((message) => message.projectId),
    );
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const warmupProject = corpus.messages[0]?.projectId ?? corpus.facts[0]?.projectId;
    if (warmupProject !== undefined) {
      spans.length = 0;
      yield* knowledge
        .recall({
          projectId: ProjectId.make(warmupProject),
          threadId: ThreadId.make("replay-warmup-thread"),
          requestId: CommandId.make("memory-recall:warmup"),
          query: "warmup cache tenant isolation keys",
          composer: { text: "warmup cache tenant isolation keys", records: [] },
          knowledgeAllowance: KNOWLEDGE_ALLOWANCE,
        })
        .pipe(Effect.provideService(Tracer.Tracer, tracer));
    }
    const rows: ReplayRow[] = [];
    for (const message of corpus.messages)
      rows.push(yield* measureMessage(message, options.candidateLimit, options.scratchProject));
    return { loaded, rows };
  }).pipe(Effect.provide(knowledgeLayer(dbPath)));
  const summary = summarizeReplay(produced.rows, {
    factsLoaded: produced.loaded,
    factScale: corpus.factScale,
    project: corpus.project,
    scratchProject: options.scratchProject ?? null,
    knowledgeAllowance: KNOWLEDGE_ALLOWANCE,
    recallTimeout: RECALL_TIMEOUT,
    citation:
      "synthetic human citation shared per project; real fact source authority is not replayed; assisted origin uses origin_thread when the export has one",
    warmupExcluded: 1,
  });
  yield* fs.makeDirectory(options.out, { recursive: true });
  const lines = produced.rows.map((row) => encodeJson(row));
  yield* fs.writeFileString(
    path.join(options.out, "results.ndjson"),
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
  );
  yield* fs.writeFileString(path.join(options.out, "summary.json"), `${encodePretty(summary)}\n`);
  return { rows: produced.rows, summary };
});

const isCli =
  process.argv[1] !== undefined && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;
if (isCli) {
  Effect.runPromise(
    replayProjectMemory(parseReplayArgs(process.argv)).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  )
    .then(({ summary }) => {
      process.stdout.write(
        `${JSON.stringify({
          messages: summary.messages,
          byGate: summary.byGate,
          lookupLatencyMs: summary.lookupLatencyMs,
          exceededMs: summary.exceededMs,
        })}\n`,
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "replay failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
