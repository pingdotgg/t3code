// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Benchmark fixture materialization uses isolated native SQLite state and deterministic timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { AgentAppCorpus, CorpusMessage, CorpusPart, CoverageEvidence } from "../contracts.ts";
import {
  writeProjectionFixture,
  type ProjectionActivityFixtureRow,
  type ProjectionFixture,
  type ProjectionMessageFixtureRow,
} from "../../projection-fixture.ts";

const MODEL_SELECTION = JSON.stringify({ instanceId: "opencode", model: "benchmark" });
const BASE_TIME_MS = Date.parse("2020-01-01T00:00:00.000Z");

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function timestamp(order: number): string {
  return new Date(BASE_TIME_MS + order).toISOString();
}

function visiblePartText(part: CorpusPart): string | undefined {
  switch (part.type) {
    case "text":
      return part.text;
    case "markdown":
      return part.markdown;
    case "code":
      return `\`\`\`${part.language}\n${part.code}\n\`\`\``;
    case "table": {
      const header = `| ${part.headers.join(" | ")} |`;
      const divider = `| ${part.headers.map(() => "---").join(" | ")} |`;
      return [header, divider, ...part.rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
    }
    case "diff":
      return part.patch;
    case "reasoning":
    case "attachment":
    case "tool":
      return undefined;
  }
}

function messageText(message: CorpusMessage): string {
  return [...message.parts]
    .sort((left, right) => left.order - right.order)
    .map(visiblePartText)
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function messageAttachments(message: CorpusMessage): string | null {
  const attachments = message.parts.flatMap((part) =>
    part.type === "attachment" && part.mediaType.startsWith("image/")
      ? [
          {
            type: "image" as const,
            id: part.id,
            name: part.name,
            mimeType: part.mediaType,
            sizeBytes: part.sizeBytes,
          },
        ]
      : [],
  );
  return attachments.length > 0 ? JSON.stringify(attachments) : null;
}

function toolItemType(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web")) return "web_search";
  return "dynamic_tool_call";
}

function activityForPart(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly part: Extract<CorpusPart, { readonly type: "tool" }>;
  readonly sequence: number;
  readonly createdAt: string;
}): ProjectionActivityFixtureRow {
  const status = input.part.state;
  return {
    activityId: input.part.callId,
    threadId: input.sessionId,
    turnId: input.turnId,
    tone: "tool",
    kind:
      status === "pending"
        ? "tool.started"
        : status === "running"
          ? "tool.updated"
          : "tool.completed",
    summary: input.part.toolName,
    payloadJson: JSON.stringify({
      itemType: toolItemType(input.part.toolName),
      title: input.part.toolName,
      status,
      input: JSON.parse(input.part.inputJson) as unknown,
      ...(input.part.outputText.length > 0 ? { detail: input.part.outputText } : {}),
    }),
    sequence: input.sequence,
    createdAt: input.createdAt,
  };
}

function unsupportedShapes(corpus: AgentAppCorpus): Array<string> {
  const shapes = new Set<string>();
  for (const session of corpus.sessions) {
    for (const turn of session.turns) {
      for (const message of turn.messages) {
        if (message.role === "system") shapes.add("system-message");
        for (const part of message.parts) {
          if (part.type === "reasoning") shapes.add("reasoning");
          if (part.type === "attachment" && !part.mediaType.startsWith("image/")) {
            shapes.add(`attachment:${part.mediaType}`);
          }
        }
      }
    }
  }
  return [...shapes].sort();
}

function buildFixture(corpus: AgentAppCorpus, workspaceRoot: string): ProjectionFixture {
  // Multi-workspace corpora assign each session a workspaceId; materialize one
  // project per workspace so warm switching crosses real project boundaries.
  // A corpus without assignments keeps the single legacy project (and its
  // digest-stable fixture) exactly as before.
  const workspaceIds = [
    ...new Set(corpus.sessions.map((session) => session.workspaceId ?? "")),
  ].sort();
  const projects = workspaceIds.map((workspaceId) => ({
    projectId: workspaceId
      ? `benchmark-${corpus.corpusId}-${workspaceId}`
      : `benchmark-${corpus.corpusId}`,
    title: workspaceId
      ? `Benchmark ${corpus.corpusId} ${workspaceId}`
      : `Benchmark ${corpus.corpusId}`,
    workspaceRoot: workspaceId ? NodePath.join(workspaceRoot, workspaceId) : workspaceRoot,
    defaultModelSelectionJson: MODEL_SELECTION,
    scriptsJson: "[]",
    createdAt: timestamp(0),
    updatedAt: timestamp(corpus.sessions.length + 1),
  }));
  const projectByWorkspace = new Map(
    projects.map((project, index) => [workspaceIds[index]!, project]),
  );
  const threads = corpus.sessions.map((session) => ({
    threadId: session.id,
    projectId: projectByWorkspace.get(session.workspaceId ?? "")!.projectId,
    title: session.title,
    modelSelectionJson: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    latestTurnId: session.turns.at(-1)?.id ?? null,
    latestUserMessageAt: timestamp(session.order * 1_000 + 1),
    createdAt: timestamp(session.order * 1_000),
    updatedAt: timestamp(session.order * 1_000 + 999),
    // The deterministic 2020 timestamps put every corpus thread far past any
    // autoSettleAfterDays window, so without a pin they materialize SETTLED:
    // the timeline renders an un-settle placeholder instead of the transcript,
    // and open/switch scenarios measure the placeholder — not the job the
    // benchmark compares across apps. "active" is the product's own keep-active
    // override (see effectiveSettled in client-runtime/state/threadSettled.ts):
    // it suppresses auto-settle exactly like a user pinning a thread, without
    // touching the timestamps the corpus digest depends on.
    settledOverride: "active",
  }));
  const turns = corpus.sessions.flatMap((session) =>
    session.turns.map((turn) => {
      const assistantMessage = turn.messages
        .toReversed()
        .find((message) => message.role === "assistant");
      return {
        threadId: session.id,
        turnId: turn.id,
        assistantMessageId: assistantMessage?.id ?? null,
        state: "completed",
        requestedAt: timestamp(session.order * 1_000_000 + turn.index * 1_000),
        startedAt: timestamp(session.order * 1_000_000 + turn.index * 1_000 + 1),
        completedAt: timestamp(session.order * 1_000_000 + turn.index * 1_000 + 999),
      };
    }),
  );
  const messages: Array<ProjectionMessageFixtureRow> = [];
  const activities: Array<ProjectionActivityFixtureRow> = [];
  for (const session of corpus.sessions) {
    for (const turn of session.turns) {
      for (const message of [...turn.messages].sort((left, right) => left.order - right.order)) {
        if (message.role === "system") continue;
        const createdAt = timestamp(
          session.order * 1_000_000 + turn.index * 1_000 + message.order * 10,
        );
        messages.push({
          messageId: message.id,
          threadId: session.id,
          turnId: turn.id,
          role: message.role,
          text: messageText(message),
          attachmentsJson: messageAttachments(message),
          createdAt,
          updatedAt: createdAt,
        });
        for (const part of [...message.parts].sort((left, right) => left.order - right.order)) {
          if (part.type === "tool") {
            activities.push(
              activityForPart({
                sessionId: session.id,
                turnId: turn.id,
                part,
                sequence: activities.length + 1,
                createdAt,
              }),
            );
          }
        }
      }
    }
  }
  return {
    projects,
    threads,
    turns,
    messages,
    activities,
    sessions: corpus.sessions.map((session) => ({
      threadId: session.id,
      status: "ready",
      providerName: "OpenCode",
      providerInstanceId: "opencode",
      runtimeMode: "full-access",
      updatedAt: timestamp(session.order * 1_000 + 999),
    })),
  };
}

interface ReadbackEvidence {
  readonly messageCount: number;
  readonly activityCount: number;
  readonly messageBytes: number;
  readonly orderedProjectionSha256: string;
}

function readback(dbPath: string): ReadbackEvidence {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const messages = database
      .prepare(
        `SELECT message_id, thread_id, turn_id, role, text, attachments_json, created_at
         FROM projection_thread_messages ORDER BY created_at, message_id`,
      )
      .all() as Array<Record<string, string | null>>;
    const activities = database
      .prepare(
        `SELECT activity_id, thread_id, turn_id, kind, payload_json, sequence, created_at
         FROM projection_thread_activities ORDER BY sequence, activity_id`,
      )
      .all() as Array<Record<string, string | number | null>>;
    return {
      messageCount: messages.length,
      activityCount: activities.length,
      messageBytes: messages.reduce(
        (total, message) => total + Buffer.byteLength(message.text ?? "", "utf8"),
        0,
      ),
      orderedProjectionSha256: sha256(JSON.stringify({ messages, activities })),
    };
  } finally {
    database.close();
  }
}

export interface T3MaterializationResult {
  readonly coverage: ReadonlyArray<CoverageEvidence>;
  readonly readback: ReadbackEvidence;
  readonly expectedProjectionSha256: string;
  readonly readinessTargets: ReadonlyArray<{
    readonly sessionId: string;
    readonly title: string;
    readonly expectedMessageIds: ReadonlyArray<string>;
  }>;
}

export function materializeT3Corpus(input: {
  readonly corpus: AgentAppCorpus;
  readonly dbPath: string;
  readonly disposableRoot: string;
  readonly workspaceRoot: string;
  readonly liveHomeDir?: string | undefined;
}): T3MaterializationResult {
  const fixture = buildFixture(input.corpus, NodePath.resolve(input.workspaceRoot));
  writeProjectionFixture({
    dbPath: input.dbPath,
    disposableRoot: input.disposableRoot,
    fixture,
    ...(input.liveHomeDir ? { liveHomeDir: input.liveHomeDir } : {}),
  });
  const evidence = readback(input.dbPath);
  const expectedMessages = fixture.messages.length;
  const expectedActivities = fixture.activities?.length ?? 0;
  const expectedMessageBytes = fixture.messages.reduce(
    (total, message) => total + Buffer.byteLength(message.text, "utf8"),
    0,
  );
  const expectedMessagesRows = fixture.messages
    .map((message) => ({
      message_id: message.messageId,
      thread_id: message.threadId,
      turn_id: message.turnId ?? null,
      role: message.role,
      text: message.text,
      attachments_json: message.attachmentsJson ?? null,
      created_at: message.createdAt,
    }))
    .sort((left, right) =>
      left.created_at === right.created_at
        ? left.message_id.localeCompare(right.message_id)
        : left.created_at.localeCompare(right.created_at),
    );
  const expectedActivityRows = [...(fixture.activities ?? [])]
    .sort(
      (left, right) =>
        (left.sequence ?? 0) - (right.sequence ?? 0) ||
        left.activityId.localeCompare(right.activityId),
    )
    .map((activity) => ({
      activity_id: activity.activityId,
      thread_id: activity.threadId,
      turn_id: activity.turnId ?? null,
      kind: activity.kind,
      payload_json: activity.payloadJson,
      sequence: activity.sequence ?? null,
      created_at: activity.createdAt,
    }));
  const expectedProjectionSha256 = sha256(
    JSON.stringify({ messages: expectedMessagesRows, activities: expectedActivityRows }),
  );
  const unsupported = unsupportedShapes(input.corpus);
  const readinessTargets = input.corpus.sessions.map((session) => {
    const latestTurnId = session.turns.at(-1)?.id;
    if (latestTurnId === undefined) {
      throw new Error(`Benchmark session ${session.id} has no latest turn to paint`);
    }
    const expectedMessageIds = fixture.messages
      .filter(
        (message) =>
          message.threadId === session.id &&
          message.turnId === latestTurnId &&
          message.text.trim().length > 0,
      )
      .map((message) => message.messageId);
    if (expectedMessageIds.length === 0) {
      throw new Error(
        `Benchmark session ${session.id} latest turn ${latestTurnId} has no visible canonical message`,
      );
    }
    return { sessionId: session.id, title: session.title, expectedMessageIds };
  });
  const readbackPassed =
    evidence.messageCount === expectedMessages &&
    evidence.activityCount === expectedActivities &&
    evidence.messageBytes === expectedMessageBytes &&
    evidence.orderedProjectionSha256 === expectedProjectionSha256;
  const base = {
    corpusDigestSha256: input.corpus.manifest.hashes.corpusSha256,
    counts: input.corpus.manifest.counts,
    semanticSha256: input.corpus.manifest.hashes.semanticSha256,
  };
  return {
    readback: evidence,
    expectedProjectionSha256,
    readinessTargets,
    coverage: [
      {
        ...base,
        profile: "workspace-core-v1",
        passed: readbackPassed,
        unsupportedShapes: unsupported,
      },
      {
        ...base,
        profile: "resource-core-v1",
        passed: readbackPassed,
        unsupportedShapes: unsupported,
      },
    ],
  };
}
