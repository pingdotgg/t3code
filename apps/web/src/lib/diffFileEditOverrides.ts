import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { createPatch } from "diff";
import { buildPatchCacheKey } from "./diffRendering";

export interface PersistedDiffFileEditOverride {
  preTurnContents: string;
  savedContents: string;
}

type PersistedDiffFileEditThreadState = Record<string, PersistedDiffFileEditOverride | undefined>;
type PersistedDiffFileEditStorageState = Record<string, PersistedDiffFileEditThreadState>;

const DIFF_FILE_EDIT_STORAGE_KEY = "harness:diff-file-edit-overrides:v1";

let memoryStorageState: PersistedDiffFileEditStorageState = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function splitTextIntoLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function normalizePersistedOverride(value: unknown): PersistedDiffFileEditOverride | null {
  if (
    !isRecord(value) ||
    typeof value.preTurnContents !== "string" ||
    typeof value.savedContents !== "string"
  ) {
    return null;
  }

  return {
    preTurnContents: value.preTurnContents,
    savedContents: value.savedContents,
  };
}

function normalizePersistedStorageState(value: unknown): PersistedDiffFileEditStorageState {
  if (!isRecord(value)) {
    return {};
  }

  const nextState: PersistedDiffFileEditStorageState = {};
  for (const [threadKey, threadValue] of Object.entries(value)) {
    if (!isRecord(threadValue)) {
      continue;
    }

    const nextThreadState: PersistedDiffFileEditThreadState = {};
    for (const [fileKey, fileValue] of Object.entries(threadValue)) {
      const normalized = normalizePersistedOverride(fileValue);
      if (normalized) {
        nextThreadState[fileKey] = normalized;
      }
    }

    if (Object.keys(nextThreadState).length > 0) {
      nextState[threadKey] = nextThreadState;
    }
  }

  return nextState;
}

function readStorageState(): PersistedDiffFileEditStorageState {
  if (typeof window === "undefined") {
    return memoryStorageState;
  }

  try {
    const raw = window.sessionStorage.getItem(DIFF_FILE_EDIT_STORAGE_KEY);
    if (!raw) {
      memoryStorageState = {};
      return memoryStorageState;
    }

    memoryStorageState = normalizePersistedStorageState(JSON.parse(raw));
    return memoryStorageState;
  } catch {
    memoryStorageState = {};
    return memoryStorageState;
  }
}

function writeStorageState(nextState: PersistedDiffFileEditStorageState): void {
  memoryStorageState = nextState;
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (Object.keys(nextState).length === 0) {
      window.sessionStorage.removeItem(DIFF_FILE_EDIT_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(DIFF_FILE_EDIT_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // Ignore persistence failures and keep the in-memory fallback.
  }
}

export function buildDiffFileEditThreadKey(
  environmentId: string | null | undefined,
  threadId: string | null | undefined,
): string | null {
  if (!environmentId || !threadId) {
    return null;
  }
  return `${environmentId}:${threadId}`;
}

export function buildDiffFileEditOverrideKey(turnId: string, filePath: string): string {
  return `${turnId}:${filePath}`;
}

export function readPersistedDiffFileEditOverrides(
  threadKey: string | null,
): PersistedDiffFileEditThreadState {
  if (!threadKey) {
    return {};
  }

  const state = readStorageState();
  return state[threadKey] ? { ...state[threadKey] } : {};
}

export function writePersistedDiffFileEditOverrides(
  threadKey: string | null,
  editsByFileKey: PersistedDiffFileEditThreadState,
): void {
  if (!threadKey) {
    return;
  }

  const nextState = { ...readStorageState() };
  if (Object.keys(editsByFileKey).length === 0) {
    delete nextState[threadKey];
  } else {
    nextState[threadKey] = { ...editsByFileKey };
  }
  writeStorageState(nextState);
}

function resolveChangeStartLineIndex(
  hunk: FileDiffMetadata["hunks"][number],
  additionLineIndex: number,
): number {
  return Math.max(0, hunk.additionStart - 1 + (additionLineIndex - hunk.additionLineIndex));
}

export function reconstructPreTurnFileContents(
  fileDiff: FileDiffMetadata,
  postTurnContents: string,
): string | null {
  const nextLines = splitTextIntoLines(postTurnContents);
  const replacements = fileDiff.hunks.flatMap((hunk) =>
    hunk.hunkContent.flatMap((content) => {
      if (content.type !== "change") {
        return [];
      }

      return [
        {
          startLineIndex: resolveChangeStartLineIndex(hunk, content.additionLineIndex),
          expectedLines: fileDiff.additionLines.slice(
            content.additionLineIndex,
            content.additionLineIndex + content.additions,
          ),
          replacementLines: fileDiff.deletionLines.slice(
            content.deletionLineIndex,
            content.deletionLineIndex + content.deletions,
          ),
        },
      ];
    }),
  );

  for (const replacement of replacements.toSorted(
    (left, right) => right.startLineIndex - left.startLineIndex,
  )) {
    const currentLines = nextLines.slice(
      replacement.startLineIndex,
      replacement.startLineIndex + replacement.expectedLines.length,
    );
    if (currentLines.join("") !== replacement.expectedLines.join("")) {
      return null;
    }

    nextLines.splice(
      replacement.startLineIndex,
      replacement.expectedLines.length,
      ...replacement.replacementLines,
    );
  }

  return nextLines.join("");
}

export function buildOverriddenFileDiff(
  filePath: string,
  override: PersistedDiffFileEditOverride,
): FileDiffMetadata | null {
  const patch = createPatch(filePath, override.preTurnContents, override.savedContents);
  const parsed = parsePatchFiles(patch, buildPatchCacheKey(patch, `override:${filePath}`));
  const files = parsed.flatMap((entry) => entry.files);
  return files[0] ?? null;
}
