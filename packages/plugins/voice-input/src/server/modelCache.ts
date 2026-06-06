// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type { WhisperModel } from "../shared/schema.ts";

export function whisperModelCacheDir(cacheDir: string): string {
  return NodePath.join(cacheDir, "models", "whisper");
}

function modelMarkerPath(cacheDir: string, model: WhisperModel): string {
  return NodePath.join(whisperModelCacheDir(cacheDir), `.t3-${model}.ready`);
}

export async function markWhisperModelCached(cacheDir: string, model: WhisperModel): Promise<void> {
  const markerPath = modelMarkerPath(cacheDir, model);
  await NodeFs.mkdir(NodePath.dirname(markerPath), { recursive: true });
  await NodeFs.writeFile(markerPath, "ready", "utf8");
}

export async function isWhisperModelCached(
  cacheDir: string,
  model: WhisperModel,
): Promise<boolean> {
  try {
    await NodeFs.access(modelMarkerPath(cacheDir, model));
    return true;
  } catch {
    return false;
  }
}
