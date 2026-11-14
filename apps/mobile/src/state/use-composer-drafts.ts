import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect } from "react";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { draftModelPickMatchesThread } from "@t3tools/shared/model";
import {
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { referencedComposerContext } from "../lib/composerContext";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import {
  EMPTY_DRAFT,
  attachmentContextRecord,
  composerDraftsAtom,
  getComposerDraftSnapshot,
  stickyComposerModelSelectionAtom,
  isEmptyDraft,
  normalizeDraft,
  withComposerDraft,
  type ComposerDraft,
  type ComposerDraftSettingsUpdate,
} from "./composer-drafts-model";
import {
  ensureComposerDraftsLoaded,
  schedulePersistComposerState,
  updateComposerDrafts,
} from "./composer-drafts-persistence";
import { scheduleUnusedComposerAttachmentCleanup } from "./composer-drafts-attachments";
import {
  contextInsertionRange,
  draftWithInsertedContext,
  draftWithoutInsertionSelection,
  rememberComposerDraftSelection,
  withReferencedContextFiles,
  type ComposerDraftInsertion,
} from "./composer-drafts-selection";
import { isNewTaskDraftKey } from "./new-task-draft-key";
import { isQueuedEditDraftKey } from "./queued-edit-draft-key";

export * from "./composer-drafts-model";
export * from "./composer-drafts-persistence";
export * from "./composer-drafts-attachments";
export * from "./composer-drafts-cloud";
export * from "./composer-drafts-merge";
export * from "./composer-drafts-selection";
export { isNewTaskDraftKey, newTaskDraftKey } from "./new-task-draft-key";

export function setStickyComposerModelSelection(modelSelection: ModelSelection): void {
  appAtomRegistry.set(stickyComposerModelSelectionAtom, modelSelection);
  schedulePersistComposerState();
}

export function setComposerDraftText(draftKey: string, value: string): void {
  let removed: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const context = referencedComposerContext(value, existing.context);
    const draft = withReferencedContextFiles(existing, value, context);
    removed = existing.attachments.filter((attachment) => !draft.attachments.includes(attachment));
    return withComposerDraft(current, draftKey, draft);
  });
  scheduleUnusedComposerAttachmentCleanup(removed);
}

export function insertComposerDraftText(
  draftKey: string,
  value: string,
  target: ComposerDraftInsertion,
): void {
  const draft = getComposerDraftSnapshot(draftKey);
  const { start, end } = contextInsertionRange(draftKey, draft, target);
  const text = draft.text.slice(0, start) + value + draft.text.slice(end);
  setComposerDraftText(draftKey, text);
  rememberComposerDraftSelection(draftKey, text, {
    start: start + value.length,
    end: start + value.length,
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

/** Restore with allowOverflow to preserve every attachment after failed sends. */
export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
  options?: {
    readonly allowOverflow?: boolean;
    readonly appendReference?: boolean;
    readonly insertion?: ComposerDraftInsertion;
    readonly maxAttachments?: number;
  },
): number {
  if (attachments.length === 0) {
    return 0;
  }
  let rejected: ReadonlyArray<DraftComposerAttachment> = [];
  let removed: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const retained = options?.appendReference
      ? draftWithoutInsertionSelection(draftKey, existing, options.insertion)
      : existing;
    const remaining = options?.allowOverflow
      ? attachments.length
      : Math.max(
          0,
          Math.min(
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
            options?.maxAttachments ?? PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          ) - retained.attachments.length,
        );
    const contextCapacity = options?.appendReference
      ? Math.max(0, COMPOSER_CONTEXT_MAX_RECORDS - (retained.context?.records.length ?? 0))
      : attachments.length;
    const accepted = attachments.slice(0, Math.min(remaining, contextCapacity));
    rejected = attachments.slice(accepted.length);
    if (accepted.length === 0) {
      return current;
    }
    let draft = { ...existing, attachments: [...existing.attachments, ...accepted] };
    if (options?.appendReference) {
      const records = accepted.map((attachment) => attachmentContextRecord(attachment));
      const inserted = draftWithInsertedContext(
        draftKey,
        draft,
        {
          text: records.map(formatComposerContextReference).join(" "),
          context: { version: 1, records },
        },
        options?.insertion,
      );
      if (!inserted) {
        rejected = attachments;
        return current;
      }
      draft = { ...inserted, attachments: [...inserted.attachments] };
      removed = existing.attachments.filter(
        (attachment) => !draft.attachments.includes(attachment),
      );
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
  scheduleUnusedComposerAttachmentCleanup([...rejected, ...removed]);
  return rejected.length;
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  const retainedIds = new Set(attachments.map((attachment) => attachment.id));
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const droppedContextIds = new Set(
      existing.context?.records
        .filter((record) => "attachmentId" in record && !retainedIds.has(record.attachmentId))
        .map((record) => record.contextId),
    );
    const text = replaceComposerContextReferences(existing.text, (ref) =>
      droppedContextIds.has(ref.contextId) ? "" : ref.source,
    );
    const draft = {
      ...existing,
      text,
      context: referencedComposerContext(text, existing.context),
      attachments,
    };
    return withComposerDraft(current, draftKey, draft);
  });
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => !retainedIds.has(attachment.id)),
  );
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const removedIds = new Set(
      existing.context?.records
        .filter((record) => "attachmentId" in record && record.attachmentId === imageId)
        .map((record) => record.contextId),
    );
    const text = replaceComposerContextReferences(existing.text, (ref) =>
      removedIds.has(ref.contextId) ? "" : ref.source,
    );
    const draft = {
      ...existing,
      text,
      context: referencedComposerContext(text, existing.context),
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    return withComposerDraft(current, draftKey, draft);
  });
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => attachment.id === imageId),
  );
}

export function setComposerDraftAttachmentUpload(
  draftKey: string,
  attachment: DraftComposerAttachment,
): boolean {
  let previous: DraftComposerAttachment | undefined;
  updateComposerDrafts((current) => {
    const draft = current[draftKey];
    previous = draft?.attachments.find((candidate) => candidate.id === attachment.id);
    if (!draft || !previous) return current;
    if (
      previous.uploadedAttachmentId === attachment.uploadedAttachmentId &&
      previous.uploadEnvironmentId === attachment.uploadEnvironmentId
    )
      return current;
    return {
      ...current,
      [draftKey]: {
        ...draft,
        attachments: draft.attachments.map((candidate) =>
          candidate.id === attachment.id
            ? {
                ...candidate,
                uploadedAttachmentId: attachment.uploadedAttachmentId,
                uploadEnvironmentId: attachment.uploadEnvironmentId,
              }
            : candidate,
        ),
      },
    };
  });
  if (previous) scheduleUnusedComposerAttachmentCleanup([previous]);
  return previous !== undefined;
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
    return withComposerDraft(current, draftKey, draft);
  });
}

export function subscribeComposerDraftModelReconciliation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
  readonly shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, unknown>>;
}): () => void {
  const draftsAtom = Atom.make(appAtomRegistry.get(composerDraftsAtom));
  const unsubscribeDrafts = appAtomRegistry.subscribe(composerDraftsAtom, (drafts) =>
    input.registry.set(draftsAtom, drafts),
  );
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const matchesAtom = Atom.make((get) => {
    const threadKeys = get(threadKeysAtom);
    const matches: Array<readonly [string, ComposerDraft]> = [];
    for (const [key, draft] of Object.entries(get(draftsAtom))) {
      if (!draft.modelSelection || isNewTaskDraftKey(key) || isQueuedEditDraftKey(key)) continue;
      const ref = parseScopedThreadKey(key);
      if (!ref || !threadKeys.has(key)) continue;
      const thread = get(input.threadShellAtom(ref));
      if (!thread || !draftModelPickMatchesThread(draft.modelSelection, thread.modelSelection))
        continue;
      // Status and selection must come from the same emission; derived atoms can update apart.
      const shell = AsyncResult.getOrElse(get(input.shellStateAtom(ref.environmentId)), () => null);
      if (shell?.status !== "live") continue;
      const authoritativeThread = Option.getOrNull(shell.snapshot)?.threads.find(
        (candidate) => candidate.id === ref.threadId,
      );
      if (
        authoritativeThread &&
        draftModelPickMatchesThread(draft.modelSelection, authoritativeThread.modelSelection)
      ) {
        matches.push([key, draft]);
      }
    }
    return matches;
  });
  const unsubscribeMatches = input.registry.subscribe(
    matchesAtom,
    (matches) => {
      if (matches.length === 0) return;
      updateComposerDrafts((current) => {
        let next = current;
        for (const [key, matchedDraft] of matches) {
          if (next[key] !== matchedDraft) continue;
          const { modelSelection: _modelSelection, ...draft } = matchedDraft;
          next = withComposerDraft(next, key, draft);
        }
        return next;
      });
    },
    { immediate: true },
  );
  return () => {
    unsubscribeMatches();
    unsubscribeDrafts();
  };
}

const composerDraftAtom = Atom.family((draftKey: string) =>
  Atom.make((get) => get(composerDraftsAtom)[draftKey] ?? EMPTY_DRAFT),
);
const EMPTY_DRAFT_ATOM = Atom.make(EMPTY_DRAFT);

type ComposerDraftsByKey = Readonly<Record<string, ComposerDraft>>;
const EMPTY_DRAFTS: ComposerDraftsByKey = {};
function sameDrafts(a: ComposerDraftsByKey, b: ComposerDraftsByKey): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
export const questionAttachmentDraftsAtom = Atom.family((prefix: string) =>
  Atom.make((get): ComposerDraftsByKey => {
    if (prefix === "") return EMPTY_DRAFTS;
    const matching = Object.entries(get(composerDraftsAtom)).filter(([key]) =>
      key.startsWith(prefix),
    );
    return matching.length === 0 ? EMPTY_DRAFTS : Object.fromEntries(matching);
  }).pipe(Atom.withEquality(sameDrafts)),
);

export const newTaskComposerDraftsAtom = Atom.make((get): ComposerDraftsByKey => {
  const matching = Object.entries(get(composerDraftsAtom)).filter(([key]) =>
    isNewTaskDraftKey(key),
  );
  return matching.length === 0 ? EMPTY_DRAFTS : Object.fromEntries(matching);
}).pipe(Atom.withEquality(sameDrafts));

type ComposerDraftUploadSource = Pick<ComposerDraft, "attachments" | "project">;
type ComposerDraftUploadSources = Readonly<Record<string, ComposerDraftUploadSource>>;
export const composerDraftUploadSourcesAtom = Atom.make((get): ComposerDraftUploadSources =>
  Object.fromEntries(
    Object.entries(get(composerDraftsAtom)).map(([key, draft]) => [
      key,
      { attachments: draft.attachments, project: draft.project },
    ]),
  ),
).pipe(
  Atom.withEquality((a: ComposerDraftUploadSources, b: ComposerDraftUploadSources) => {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) => a[key]?.attachments === b[key]?.attachments && a[key]?.project === b[key]?.project,
      )
    );
  }),
);

type ComposerDraftSettings = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;
const EMPTY_DRAFT_SETTINGS: ComposerDraftSettings = {};
const composerDraftSettingsAtom = Atom.family((draftKey: string) =>
  Atom.make((get): ComposerDraftSettings => {
    const draft = get(composerDraftAtom(draftKey));
    return {
      modelSelection: draft.modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
    };
  }).pipe(
    Atom.withEquality(
      (a: ComposerDraftSettings, b: ComposerDraftSettings) =>
        a.modelSelection === b.modelSelection &&
        a.runtimeMode === b.runtimeMode &&
        a.interactionMode === b.interactionMode,
    ),
  ),
);
const EMPTY_DRAFT_SETTINGS_ATOM = Atom.make(EMPTY_DRAFT_SETTINGS);

export function useComposerDraftSettings(draftKey: string | null): ComposerDraftSettings {
  const settings = useAtomValue(
    draftKey ? composerDraftSettingsAtom(draftKey) : EMPTY_DRAFT_SETTINGS_ATOM,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts loading persisted composer drafts from native storage on first use
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return settings;
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const draft = useAtomValue(draftKey ? composerDraftAtom(draftKey) : EMPTY_DRAFT_ATOM);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts loading persisted composer drafts from native storage on first use
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draft;
}

export function useStickyComposerModelSelection(): ModelSelection | null {
  const selection = useAtomValue(stickyComposerModelSelectionAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts loading persisted composer drafts from native storage on first use
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return selection;
}
