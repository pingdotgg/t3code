import { useAtomValue } from "@effect/atom-react";
import {
  ModelSelection as ModelSelectionSchema,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";

const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFTS_FILE = "drafts.json";
const PERSIST_DEBOUNCE_MS = 200;

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "encode", "write", "hydrate"]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
}

export interface ComposerDraftWorkspaceSelection {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection"
>;

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
});

const PersistedComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
});

const decodePersistedComposerDraftsDocument = Schema.decodeUnknownSync(
  PersistedComposerDraftsSchema,
);

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft {
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey]);
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  const parsed = decodePersistedComposerDraftsDocument(value);
  return Object.fromEntries(
    Object.entries(parsed.drafts).filter(([, draft]) => !isEmptyDraft(draft)),
  );
}

async function getComposerDraftsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, COMPOSER_DRAFTS_FILE);
}

async function loadPersistedComposerDrafts(): Promise<Record<string, ComposerDraft>> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    if (!file.exists) {
      return {};
    }
    operation = "read";
    const raw = await file.text();
    operation = "decode";
    return decodePersistedComposerDrafts(JSON.parse(raw) as unknown);
  } catch (cause) {
    console.warn(
      "[composer-drafts] ignored persisted draft failure",
      new ComposerDraftPersistenceError({
        operation,
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: COMPOSER_DRAFTS_FILE,
        cause,
      }),
    );
    return {};
  }
}

async function writePersistedComposerDrafts(drafts: Record<string, ComposerDraft>): Promise<void> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    operation = "encode";
    const nonEmptyDrafts = Object.fromEntries(
      Object.entries(drafts).filter(([, draft]) => !isEmptyDraft(draft)),
    );
    const document = {
      schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
      drafts: nonEmptyDrafts,
    } as const;
    const encoded = JSON.stringify(document);
    operation = "write";
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(encoded);
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    });
  }
}

async function savePersistedComposerDrafts(drafts: Record<string, ComposerDraft>): Promise<void> {
  try {
    await writePersistedComposerDrafts(drafts);
  } catch (error) {
    console.warn("[composer-drafts] failed to persist drafts", error);
    // Draft persistence is best-effort; in-memory drafts still keep working.
  }
}

function schedulePersistComposerDrafts(drafts: Record<string, ComposerDraft>): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void savePersistedComposerDrafts(drafts);
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  loadPromise = loadPersistedComposerDrafts()
    .then((persistedDrafts) => {
      if (Object.keys(persistedDrafts).length === 0) {
        return;
      }
      const current = appAtomRegistry.get(composerDraftsAtom);
      appAtomRegistry.set(composerDraftsAtom, {
        ...persistedDrafts,
        ...current,
      });
    })
    .catch((cause) => {
      console.warn(
        "[composer-drafts] failed to hydrate drafts",
        new ComposerDraftPersistenceError({
          operation: "hydrate",
          directory: COMPOSER_DRAFTS_DIRECTORY,
          fileName: COMPOSER_DRAFTS_FILE,
          cause,
        }),
      );
      // Draft loading is best-effort; in-memory drafts still keep working.
    });
}

function updateComposerDrafts(
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
): void {
  const next = update(appAtomRegistry.get(composerDraftsAtom));
  appAtomRegistry.set(composerDraftsAtom, next);
  schedulePersistComposerDrafts(next);
}

export function setComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      text: value,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function appendComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    };
  });
}

export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  if (attachments.length === 0) {
    return;
  }
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...attachments],
      },
    };
  });
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      attachments,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const draft = {
      ...existing,
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...settings,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const draft = {
    ...existing,
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  // Import retries are possible after an interrupted native handoff. Keep the
  // operation idempotent when the same shared text is already present.
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id));
  const incomingAttachments = content.attachments.filter((attachment) => {
    if (attachmentIds.has(attachment.id)) {
      return false;
    }
    attachmentIds.add(attachment.id);
    return true;
  });
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
  const text = mergeComposerDraftText(existing.text, content.text);
  if (text === existing.text && attachments.length === existing.attachments.length) {
    return current;
  }
  return {
    ...current,
    [draftKey]: {
      ...existing,
      text,
      attachments,
    },
  };
}

/**
 * Atomically moves an incoming share into a project-scoped composer draft.
 * The durable write happens before the share inbox item can be acknowledged.
 */
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = mergeComposerDraftContentState(current, draftKey, content);
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length;
  if (next === current) {
    return { skippedAttachmentCount };
  }
  await writePersistedComposerDrafts(next);
  appAtomRegistry.set(composerDraftsAtom, next);
  return { skippedAttachmentCount };
}

export async function flushComposerDrafts(): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await writePersistedComposerDrafts(appAtomRegistry.get(composerDraftsAtom));
}

export function clearComposerDraftContent(draftKey: string): void {
  updateComposerDrafts((current) => clearComposerDraftContentState(current, draftKey));
}

export function clearComposerDraft(draftKey: string): void {
  updateComposerDrafts((current) => {
    if (!current[draftKey]) {
      return current;
    }
    const next = { ...current };
    delete next[draftKey];
    return next;
  });
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  );
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }

  const next = removeComposerDraftsForEnvironment(
    appAtomRegistry.get(composerDraftsAtom),
    environmentId,
  );

  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  await writePersistedComposerDrafts(next);
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}
