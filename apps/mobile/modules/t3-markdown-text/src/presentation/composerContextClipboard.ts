interface DisplayRecord {
  contextId: string; kind: string; path: string; name?: string; mimeType?: string;
  sectionId?: string; sizeBytes?: number; pullRequest?: { state?: string; isDraft?: boolean };
}
/** Decode optional copied UI metadata; the backend does not depend on this format. */
export function decodeComposerContextFragment(value: string): { records: DisplayRecord[] } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("records" in parsed) || !Array.isArray(parsed.records)) return null;
    return { records: parsed.records.filter((record): record is DisplayRecord =>
      record && typeof record.contextId === "string" && typeof record.kind === "string") };
  } catch { return null; }
}
