import {
  EDITORS,
  MAX_OPEN_WITH_ID_LENGTH,
  type EditorId,
  type OpenWithEntry,
  type OpenWithEntryPresentation,
  type OpenWithEntryRef,
} from "@t3tools/contracts";

export interface BuiltinOpenWithOption {
  readonly type: "builtin";
  readonly id: EditorId;
}

export interface CustomOpenWithOption {
  readonly type: "custom";
  readonly entry: OpenWithEntry;
  readonly presentation: OpenWithEntryPresentation | null;
}

export type OpenWithOption = BuiltinOpenWithOption | CustomOpenWithOption;

const refsEqual = (left: OpenWithEntryRef, right: OpenWithEntryRef): boolean =>
  left.type === right.type && left.id === right.id;

export const refForOpenWithOption = (option: OpenWithOption): OpenWithEntryRef =>
  option.type === "builtin"
    ? { type: "builtin", id: option.id }
    : { type: "custom", id: option.entry.id };

export function mergeOpenWithOptions(input: {
  readonly availableEditors: readonly EditorId[];
  readonly customEntries: readonly OpenWithEntry[];
  readonly presentations: readonly OpenWithEntryPresentation[];
  readonly includeCustomEntries: boolean;
}): readonly OpenWithOption[] {
  const available = new Set(input.availableEditors);
  const builtins: BuiltinOpenWithOption[] = EDITORS.filter((editor) =>
    available.has(editor.id),
  ).map((editor) => ({ type: "builtin", id: editor.id }));
  if (!input.includeCustomEntries) return builtins;
  const presentationById = new Map(input.presentations.map((entry) => [entry.entryId, entry]));
  return [
    ...builtins,
    ...input.customEntries.map(
      (entry): CustomOpenWithOption => ({
        type: "custom",
        entry,
        presentation: presentationById.get(entry.id) ?? null,
      }),
    ),
  ];
}

export function resolveEffectiveOpenWith(input: {
  readonly options: readonly OpenWithOption[];
  readonly preferred: OpenWithEntryRef | null;
  readonly legacyPreferredEditor: EditorId | null;
}): OpenWithOption | null {
  if (input.preferred) {
    const preferred = input.options.find((option) =>
      refsEqual(refForOpenWithOption(option), input.preferred!),
    );
    if (
      preferred &&
      (preferred.type === "builtin" || preferred.presentation?.available !== false)
    ) {
      return preferred;
    }
  }

  if (input.preferred === null && input.legacyPreferredEditor) {
    const legacy = input.options.find(
      (option) => option.type === "builtin" && option.id === input.legacyPreferredEditor,
    );
    if (legacy) return legacy;
  }
  return input.options.find((option) => option.type === "builtin") ?? null;
}

function normalizeOpenWithId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = cleaned || "application";
  return fallback.slice(0, MAX_OPEN_WITH_ID_LENGTH).replace(/-+$/g, "") || "application";
}

export function nextOpenWithEntryId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const base = normalizeOpenWithId(name);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, MAX_OPEN_WITH_ID_LENGTH - suffixText.length)}${suffixText}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, MAX_OPEN_WITH_ID_LENGTH);
}
