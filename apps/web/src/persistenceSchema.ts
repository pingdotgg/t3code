import { z } from "zod";
import { projectScriptSchema } from "@t3tools/contracts";

import { DEFAULT_MODEL, resolveModelSlug } from "./model-logic";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type RuntimeMode,
  type Thread,
  type ThreadTerminalGroup,
} from "./types";

const LEGACY_DEFAULT_MODEL = "gpt-5.2-codex";

const persistedProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().min(1),
  expanded: z.boolean(),
  scripts: z.array(projectScriptSchema).default([]),
});

const persistedMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  attachments: z
    .array(
      z.object({
        type: z.literal("image"),
        id: z.string().min(1),
        name: z.string().min(1),
        mimeType: z.string().min(1),
        sizeBytes: z.number().int().min(1),
      }),
    )
    .optional(),
  createdAt: z.string().min(1),
  streaming: z.boolean(),
});

const persistedTerminalGroupSchema = z.object({
  id: z.string().trim().min(1),
  terminalIds: z.array(z.string().trim().min(1)),
});

const persistedTurnDiffFileChangeSchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1).optional(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
});

const persistedTurnDiffSummarySchema = z.object({
  turnId: z.string().min(1),
  completedAt: z.string().min(1),
  status: z.string().min(1).optional(),
  files: z.array(persistedTurnDiffFileChangeSchema),
  assistantMessageId: z.string().min(1).optional(),
  checkpointTurnCount: z.number().int().min(0).optional(),
});

const persistedThreadSchema = z.object({
  id: z.string().min(1),
  codexThreadId: z.string().min(1).nullable().default(null),
  projectId: z.string().min(1),
  title: z.string().min(1),
  model: z.string().min(1),
  terminalOpen: z.boolean().default(false),
  terminalHeight: z.number().int().min(120).max(4_096).default(DEFAULT_THREAD_TERMINAL_HEIGHT),
  terminalIds: z.array(z.string().trim().min(1)).default([DEFAULT_THREAD_TERMINAL_ID]),
  activeTerminalId: z.string().trim().min(1).default(DEFAULT_THREAD_TERMINAL_ID),
  terminalGroups: z.array(persistedTerminalGroupSchema).default([]),
  activeTerminalGroupId: z.string().trim().min(1).optional(),
  // Legacy v6 and older fields retained for migration.
  terminalLayout: z.enum(["single", "split", "tabs"]).optional(),
  splitTerminalIds: z.array(z.string().trim().min(1)).optional(),
  messages: z.array(persistedMessageSchema),
  createdAt: z.string().min(1),
  lastVisitedAt: z.string().min(1).optional(),
  branch: z.string().min(1).nullable().optional(),
  worktreePath: z.string().min(1).nullable().optional(),
  turnDiffSummaries: z.array(persistedTurnDiffSummarySchema).catch([]).default([]),
});

const persistedStateBodySchema = z.object({
  projects: z.array(persistedProjectSchema),
  threads: z.array(persistedThreadSchema),
  activeThreadId: z.string().min(1).nullable().optional(),
});

const runtimeModeSchema = z.enum(["approval-required", "full-access"]);

export const persistedStateV1Schema = persistedStateBodySchema.extend({
  version: z.literal(1).optional(),
});

export const persistedStateV2Schema = persistedStateBodySchema.extend({
  version: z.literal(2).optional(),
});

export const persistedStateV3Schema = persistedStateBodySchema.extend({
  runtimeMode: runtimeModeSchema.default(DEFAULT_RUNTIME_MODE),
  version: z.literal(3).optional(),
});

export const persistedStateV4Schema = persistedStateBodySchema.extend({
  runtimeMode: runtimeModeSchema.default(DEFAULT_RUNTIME_MODE),
  version: z.literal(4).optional(),
});

export const persistedStateV6Schema = persistedStateBodySchema.extend({
  runtimeMode: runtimeModeSchema.default(DEFAULT_RUNTIME_MODE),
  version: z.literal(6).optional(),
});

export const persistedStateV7Schema = persistedStateBodySchema.extend({
  runtimeMode: runtimeModeSchema.default(DEFAULT_RUNTIME_MODE),
  version: z.literal(7).optional(),
});

export const persistedStateV5Schema = persistedStateBodySchema.extend({
  runtimeMode: runtimeModeSchema.default(DEFAULT_RUNTIME_MODE),
  version: z.literal(5).optional(),
});

const persistedStateSchema = z.union([
  persistedStateV7Schema,
  persistedStateV6Schema,
  persistedStateV5Schema,
  persistedStateV4Schema,
  persistedStateV3Schema,
  persistedStateV2Schema,
  persistedStateV1Schema,
]);

export interface PersistedStoreSnapshot {
  projects: Project[];
  threads: Thread[];
  runtimeMode: RuntimeMode;
}

function maybeMigrateLegacyModel(model: string, isLegacyPayload: boolean): string {
  if (!isLegacyPayload) {
    return model;
  }

  return model === LEGACY_DEFAULT_MODEL ? DEFAULT_MODEL : model;
}

function hydrateProject(
  project: z.infer<typeof persistedProjectSchema>,
  isLegacyPayload: boolean,
): Project {
  return {
    ...project,
    model: resolveModelSlug(maybeMigrateLegacyModel(project.model, isLegacyPayload)),
    scripts: project.scripts,
  };
}

function hydrateThread(
  thread: z.infer<typeof persistedThreadSchema>,
  isLegacyPayload: boolean,
): Thread {
  const terminalIds = [
    ...new Set(thread.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const safeTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const activeTerminalId = safeTerminalIds.includes(thread.activeTerminalId)
    ? thread.activeTerminalId
    : (safeTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const safeTerminalIdSet = new Set(safeTerminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const normalizedGroups: ThreadTerminalGroup[] = [];
  const assignUniqueGroupId = (groupId: string): string => {
    if (!usedGroupIds.has(groupId)) {
      usedGroupIds.add(groupId);
      return groupId;
    }
    let suffix = 2;
    while (usedGroupIds.has(`${groupId}-${suffix}`)) {
      suffix += 1;
    }
    const uniqueGroupId = `${groupId}-${suffix}`;
    usedGroupIds.add(uniqueGroupId);
    return uniqueGroupId;
  };

  for (const terminalGroup of thread.terminalGroups) {
    const nextTerminalIds = [
      ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ].filter((terminalId) => {
      if (!safeTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (nextTerminalIds.length === 0) continue;
    for (const terminalId of nextTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      terminalGroup.id.trim().length > 0
        ? terminalGroup.id.trim()
        : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
    normalizedGroups.push({
      id: assignUniqueGroupId(baseGroupId),
      terminalIds: nextTerminalIds,
    });
  }

  if (normalizedGroups.length === 0 && thread.terminalLayout === "split") {
    const splitTerminalIds = [
      ...new Set(
        (thread.splitTerminalIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
      ),
    ].filter((terminalId) => safeTerminalIdSet.has(terminalId));
    if (splitTerminalIds.length >= 2) {
      const splitGroupTerminalIds = splitTerminalIds.slice(0, 2);
      for (const terminalId of splitGroupTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }
      normalizedGroups.push({
        id: assignUniqueGroupId(`group-${splitGroupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`),
        terminalIds: splitGroupTerminalIds,
      });
    }
  }

  for (const terminalId of safeTerminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    normalizedGroups.push({
      id: assignUniqueGroupId(`group-${terminalId}`),
      terminalIds: [terminalId],
    });
  }

  const activeGroupIndexFromId = normalizedGroups.findIndex(
    (terminalGroup) => terminalGroup.id === thread.activeTerminalGroupId,
  );
  const activeGroupIndexFromTerminal = normalizedGroups.findIndex((terminalGroup) =>
    terminalGroup.terminalIds.includes(activeTerminalId),
  );
  const activeGroupIndex =
    activeGroupIndexFromId >= 0
      ? activeGroupIndexFromId
      : activeGroupIndexFromTerminal >= 0
        ? activeGroupIndexFromTerminal
        : 0;
  const activeTerminalGroupId =
    normalizedGroups[activeGroupIndex]?.id ??
    normalizedGroups[0]?.id ??
    `group-${DEFAULT_THREAD_TERMINAL_ID}`;

  return {
    id: thread.id,
    codexThreadId: thread.codexThreadId,
    projectId: thread.projectId,
    title: thread.title,
    model: resolveModelSlug(maybeMigrateLegacyModel(thread.model, isLegacyPayload)),
    terminalOpen: thread.terminalOpen ?? false,
    terminalHeight: thread.terminalHeight ?? DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: safeTerminalIds,
    runningTerminalIds: [],
    activeTerminalId,
    terminalGroups: normalizedGroups,
    activeTerminalGroupId,
    session: null,
    messages: thread.messages.map((message) => {
      const hydratedAttachments = message.attachments?.map((attachment) => ({ ...attachment }));
      return {
        id: message.id,
        role: message.role,
        text: message.text,
        ...(hydratedAttachments && hydratedAttachments.length > 0
          ? { attachments: hydratedAttachments }
          : {}),
        createdAt: message.createdAt,
        streaming: false,
      };
    }),
    events: [],
    error: null,
    createdAt: thread.createdAt,
    lastVisitedAt: thread.lastVisitedAt,
    branch: thread.branch ?? null,
    worktreePath: thread.worktreePath ?? null,
    turnDiffSummaries: thread.turnDiffSummaries.map((summary) => ({
      turnId: summary.turnId,
      completedAt: summary.completedAt,
      ...(summary.status ? { status: summary.status } : {}),
      files: summary.files.map((file) => ({
        path: file.path,
        ...(file.kind ? { kind: file.kind } : {}),
        ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
        ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
      })),
      ...(summary.assistantMessageId ? { assistantMessageId: summary.assistantMessageId } : {}),
      ...(typeof summary.checkpointTurnCount === "number"
        ? { checkpointTurnCount: summary.checkpointTurnCount }
        : {}),
    })),
  };
}

export function hydratePersistedState(
  raw: string,
  isLegacyPayload: boolean,
): PersistedStoreSnapshot | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsedState = persistedStateSchema.safeParse(parsedJson);
  if (!parsedState.success) {
    return null;
  }

  const projects = parsedState.data.projects.map((project) =>
    hydrateProject(project, isLegacyPayload),
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const threads = parsedState.data.threads
    .map((thread) => hydrateThread(thread, isLegacyPayload))
    .filter((thread) => projectIds.has(thread.projectId));
  return {
    projects,
    threads,
    runtimeMode:
      "runtimeMode" in parsedState.data ? parsedState.data.runtimeMode : DEFAULT_RUNTIME_MODE,
  };
}

export function toPersistedState(
  state: PersistedStoreSnapshot,
): z.infer<typeof persistedStateV7Schema> {
  return {
    version: 7,
    projects: state.projects,
    threads: state.threads.map((thread) => ({
      id: thread.id,
      codexThreadId: thread.codexThreadId,
      projectId: thread.projectId,
      title: thread.title,
      model: thread.model,
      terminalOpen: thread.terminalOpen,
      terminalHeight: thread.terminalHeight,
      terminalIds: thread.terminalIds,
      activeTerminalId: thread.activeTerminalId,
      terminalGroups: thread.terminalGroups,
      activeTerminalGroupId: thread.activeTerminalGroupId,
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        ...(message.attachments && message.attachments.length > 0
          ? {
              attachments: message.attachments.map((attachment) => ({
                type: attachment.type,
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              })),
            }
          : {}),
        createdAt: message.createdAt,
        streaming: message.streaming,
      })),
      createdAt: thread.createdAt,
      ...(thread.lastVisitedAt ? { lastVisitedAt: thread.lastVisitedAt } : {}),
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      turnDiffSummaries: thread.turnDiffSummaries.map((summary) => ({
        turnId: summary.turnId,
        completedAt: summary.completedAt,
        ...(summary.status ? { status: summary.status } : {}),
        files: summary.files.map((file) => ({
          path: file.path,
          ...(file.kind ? { kind: file.kind } : {}),
          ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
          ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
        })),
        ...(summary.assistantMessageId ? { assistantMessageId: summary.assistantMessageId } : {}),
        ...(typeof summary.checkpointTurnCount === "number"
          ? { checkpointTurnCount: summary.checkpointTurnCount }
          : {}),
      })),
    })),
    runtimeMode: state.runtimeMode,
  };
}
