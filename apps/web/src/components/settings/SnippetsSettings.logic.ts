/**
 * Pure logic for the saved-prompt snippet settings panel.
 *
 * Mirrors the `KeybindingsSettings.logic.ts` pattern: state-free functions
 * that operate on a `SnippetMap` and produce derived data (rows, ids,
 * suggested ids, search filtering, sort). Kept separate from the component
 * file so the component can stay focused on rendering and the logic stays
 * unit-testable.
 *
 * The actual persistence is in `useUpdateSettings()` (whole-map replace on
 * `ServerSettings.promptSnippets`); this file is the read/derive layer.
 */
import {
  MAX_SNIPPET_BODY_LENGTH,
  MAX_SNIPPET_DESCRIPTION_LENGTH,
  MAX_SNIPPET_ID_LENGTH,
  MAX_SNIPPET_TITLE_LENGTH,
  type Snippet,
  type SnippetId,
  type SnippetMap,
} from "@t3tools/contracts";

export const SNIPPET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface SnippetRow {
  readonly snippet: Snippet;
}

export interface SnippetValidationError {
  readonly field: "id" | "title" | "body" | "description";
  readonly message: string;
}

export interface SnippetDraftInput {
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly body?: string | undefined;
}

export interface NewSnippetDraft {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

export function normalizeSnippetId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "snippet";
  if (cleaned.length <= MAX_SNIPPET_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SNIPPET_ID_LENGTH).replace(/-+$/g, "") || "snippet";
}

export function nextSnippetId(title: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeSnippetId(title);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SNIPPET_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SNIPPET_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) return safeCandidate;
    suffix += 1;
  }
  return `${baseId}-${Date.now()}`.slice(0, MAX_SNIPPET_ID_LENGTH);
}

export function isValidSnippetId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SNIPPET_ID_LENGTH) return false;
  return SNIPPET_ID_PATTERN.test(value);
}

export function validateSnippetDraft(input: SnippetDraftInput): SnippetValidationError[] {
  const errors: SnippetValidationError[] = [];

  const id = input.id?.trim() ?? "";
  if (id.length === 0) {
    errors.push({ field: "id", message: "Trigger is required." });
  } else if (!isValidSnippetId(id)) {
    errors.push({
      field: "id",
      message:
        "Trigger must start with a letter or digit and contain only lowercase letters, digits, and dashes.",
    });
  } else if (id.length > MAX_SNIPPET_ID_LENGTH) {
    errors.push({
      field: "id",
      message: `Trigger must be ${MAX_SNIPPET_ID_LENGTH} characters or fewer.`,
    });
  }

  const title = input.title?.trim() ?? "";
  if (title.length === 0) {
    errors.push({ field: "title", message: "Title is required." });
  } else if (title.length > MAX_SNIPPET_TITLE_LENGTH) {
    errors.push({
      field: "title",
      message: `Title must be ${MAX_SNIPPET_TITLE_LENGTH} characters or fewer.`,
    });
  }

  const body = input.body ?? "";
  if (body.length === 0) {
    errors.push({ field: "body", message: "Body is required." });
  } else if (body.length > MAX_SNIPPET_BODY_LENGTH) {
    errors.push({
      field: "body",
      message: `Body must be ${MAX_SNIPPET_BODY_LENGTH} characters or fewer.`,
    });
  }

  const description = input.description?.trim() ?? "";
  if (description.length > MAX_SNIPPET_DESCRIPTION_LENGTH) {
    errors.push({
      field: "description",
      message: `Description must be ${MAX_SNIPPET_DESCRIPTION_LENGTH} characters or fewer.`,
    });
  }

  return errors;
}

export function buildSnippetRows(snippets: SnippetMap): SnippetRow[] {
  return Object.values(snippets)
    .map((snippet) => ({ snippet }))
    .sort((a, b) => {
      const titleCmp = a.snippet.title.localeCompare(b.snippet.title);
      if (titleCmp !== 0) return titleCmp;
      return a.snippet.id.localeCompare(b.snippet.id);
    });
}

export function filterSnippetRows(rows: SnippetRow[], query: string): SnippetRow[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return rows;
  return rows.filter(({ snippet }) => {
    if (snippet.id.toLowerCase().includes(trimmed)) return true;
    if (snippet.title.toLowerCase().includes(trimmed)) return true;
    if (snippet.description?.toLowerCase().includes(trimmed)) return true;
    if (snippet.body.toLowerCase().includes(trimmed)) return true;
    return false;
  });
}

export function snippetIdList(snippets: SnippetMap): SnippetId[] {
  return Object.keys(snippets) as SnippetId[];
}

export function nowIsoDateTime(): string {
  return new Date().toISOString();
}

export function newSnippetFromDraft(draft: NewSnippetDraft, now = nowIsoDateTime()): Snippet {
  return {
    id: draft.id as SnippetId,
    title: draft.title,
    ...(draft.description.length > 0 ? { description: draft.description } : {}),
    body: draft.body,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateSnippetFromDraft(
  current: Snippet,
  draft: { id: string; title: string; description: string; body: string },
  now = nowIsoDateTime(),
): Snippet {
  const base: Snippet = {
    id: draft.id as SnippetId,
    createdAt: current.createdAt,
    title: draft.title,
    body: draft.body,
    updatedAt: now,
  };
  if (draft.description.length > 0) {
    return { ...base, description: draft.description };
  }
  return base;
}

export function removeSnippet(snippets: SnippetMap, id: string): SnippetMap {
  if (!(id in snippets)) return snippets;
  const next: SnippetMap = { ...snippets };
  delete (next as Record<string, Snippet | undefined>)[id];
  return next;
}

export function upsertSnippet(snippets: SnippetMap, snippet: Snippet): SnippetMap {
  return { ...snippets, [snippet.id]: snippet };
}

export function replaceSnippet(
  snippets: SnippetMap,
  previousId: string,
  snippet: Snippet,
): SnippetMap {
  const next = removeSnippet(snippets, previousId);
  return upsertSnippet(next, snippet);
}
