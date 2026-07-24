export const THREAD_LABEL_NAME_MAX_LENGTH = 32;

export const THREAD_LABEL_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
] as const;

export interface ThreadLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export function resolveAssignedThreadLabels(
  labels: readonly ThreadLabel[],
  assignedIds: readonly string[],
): ThreadLabel[] {
  if (assignedIds.length === 0) {
    return [];
  }

  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const resolved: ThreadLabel[] = [];
  const seenIds = new Set<string>();
  for (const labelId of assignedIds) {
    if (seenIds.has(labelId)) {
      continue;
    }
    seenIds.add(labelId);
    const label = labelsById.get(labelId);
    if (label) {
      resolved.push(label);
    }
  }
  return resolved;
}

let nextThreadLabelId = 0;

export function normalizeThreadLabelName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, THREAD_LABEL_NAME_MAX_LENGTH);
}

export function normalizeThreadLabelColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^#[\da-f]{6}$/.test(normalized) ? normalized : null;
}

export function sanitizeThreadLabels(value: unknown): ThreadLabel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const labels: ThreadLabel[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const id = "id" in candidate && typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name =
      "name" in candidate && typeof candidate.name === "string"
        ? normalizeThreadLabelName(candidate.name)
        : "";
    const color =
      "color" in candidate && typeof candidate.color === "string"
        ? normalizeThreadLabelColor(candidate.color)
        : null;
    const normalizedName = name.toLocaleLowerCase();
    if (!id || !name || !color || seenIds.has(id) || seenNames.has(normalizedName)) {
      continue;
    }
    seenIds.add(id);
    seenNames.add(normalizedName);
    labels.push({ id, name, color });
  }
  return labels;
}

export function createThreadLabelId(): string {
  const sequence = nextThreadLabelId++;
  return `label-${Date.now().toString(36)}-${sequence.toString(36)}`;
}
