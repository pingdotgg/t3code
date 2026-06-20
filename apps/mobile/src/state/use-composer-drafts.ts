import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

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
}

interface PersistedComposerDrafts {
  readonly schemaVersion: typeof COMPOSER_DRAFTS_SCHEMA_VERSION;
  readonly drafts: Record<string, ComposerDraft>;
}

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
    text: draft.text,
    attachments: draft.attachments,
  };
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
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
    const parsed = JSON.parse(raw) as Partial<PersistedComposerDrafts>;
    if (parsed.schemaVersion !== COMPOSER_DRAFTS_SCHEMA_VERSION || !parsed.drafts) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.drafts).filter((entry): entry is [string, ComposerDraft] => {
        const draft = entry[1];
        return (
          typeof draft?.text === "string" &&
          Array.isArray(draft.attachments) &&
          !isEmptyDraft(draft)
        );
      }),
    );
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
    const document: PersistedComposerDrafts = {
      schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
      drafts: nonEmptyDrafts,
    };
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
  return Object.fromEntries(
    Object.entries(drafts).filter(([draftKey]) => !draftKey.startsWith(environmentPrefix)),
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
