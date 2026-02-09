import { z } from "zod";

import { DEFAULT_MODEL, resolveModelSlug } from "./model-logic";
import {
  DEFAULT_RUNTIME_MODE,
  type Project,
  type RuntimeMode,
  type Thread,
} from "./types";

const LEGACY_DEFAULT_MODEL = "gpt-5.2-codex";

const persistedProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().min(1),
  expanded: z.boolean(),
});

const persistedMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string().min(1),
  streaming: z.boolean(),
});

const persistedThreadSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(persistedMessageSchema),
  createdAt: z.string().min(1),
});

const persistedStateBodySchema = z.object({
  projects: z.array(persistedProjectSchema),
  threads: z.array(persistedThreadSchema),
  activeThreadId: z.string().min(1).nullable(),
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

const persistedStateSchema = z.union([
  persistedStateV3Schema,
  persistedStateV2Schema,
  persistedStateV1Schema,
]);

export interface PersistedStoreSnapshot {
  projects: Project[];
  threads: Thread[];
  activeThreadId: string | null;
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
  };
}

function hydrateThread(
  thread: z.infer<typeof persistedThreadSchema>,
  isLegacyPayload: boolean,
): Thread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    model: resolveModelSlug(maybeMigrateLegacyModel(thread.model, isLegacyPayload)),
    session: null,
    messages: thread.messages.map((message) => ({
      ...message,
      streaming: false,
    })),
    events: [],
    error: null,
    createdAt: thread.createdAt,
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
  const hasActiveThread = Boolean(
    parsedState.data.activeThreadId &&
    threads.some((thread) => thread.id === parsedState.data.activeThreadId),
  );

  return {
    projects,
    threads,
    activeThreadId: hasActiveThread
      ? parsedState.data.activeThreadId
      : (threads[0]?.id ?? null),
    runtimeMode:
      "runtimeMode" in parsedState.data
        ? parsedState.data.runtimeMode
        : DEFAULT_RUNTIME_MODE,
  };
}

export function toPersistedState(
  state: PersistedStoreSnapshot,
): z.infer<typeof persistedStateV3Schema> {
  return {
    version: 3,
    projects: state.projects,
    threads: state.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      model: thread.model,
      messages: thread.messages,
      createdAt: thread.createdAt,
    })),
    activeThreadId: state.activeThreadId,
    runtimeMode: state.runtimeMode,
  };
}
