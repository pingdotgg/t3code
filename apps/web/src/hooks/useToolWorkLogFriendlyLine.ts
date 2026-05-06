import {
  type EnvironmentId,
  type GitSummarizeToolWorkLogInput,
  type ModelSelection,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import {
  readToolWorkLogSummaryCache,
  writeToolWorkLogSummaryCache,
} from "~/lib/toolWorkLogSummaryCache";
import { type WorkLogEntry, workLogEntryIsToolLike } from "~/session-logic";
import { useSettings } from "./useSettings";

const inFlight = new Map<string, Promise<string>>();

function modelSelectionWireKey(modelSelection: ModelSelection): string {
  return JSON.stringify({
    i: modelSelection.instanceId,
    m: modelSelection.model,
    o: modelSelection.options ?? [],
  });
}

function cacheKey(environmentId: EnvironmentId, workEntryId: string, modelKey: string): string {
  return `${environmentId}:${workEntryId}:${modelKey}`;
}

function shouldSummarizeWorkLogEntry(entry: WorkLogEntry): boolean {
  if (!entry.label.trim()) {
    return false;
  }
  if (workLogEntryIsToolLike(entry)) {
    return true;
  }
  if (entry.toolTitle !== undefined) {
    return true;
  }
  if (entry.tone === "tool") {
    return true;
  }
  return (
    entry.tone === "info" &&
    (entry.detail?.trim().length ?? 0) > 0 &&
    (entry.command !== undefined || entry.itemType !== undefined)
  );
}

async function loadFriendlyLine(
  environmentId: EnvironmentId,
  key: string,
  input: GitSummarizeToolWorkLogInput,
): Promise<string> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const started = (async () => {
    const cached = await readToolWorkLogSummaryCache(key);
    if (cached !== undefined && cached.length > 0) {
      return cached;
    }
    const line = await ensureEnvironmentApi(environmentId)
      .vcs.summarizeToolWorkLog(input)
      .then((result) => result.line);
    await writeToolWorkLogSummaryCache(key, line);
    return line;
  })();
  const tracked = started.finally(() => {
    if (inFlight.get(key) === tracked) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, tracked);
  return tracked;
}

/**
 * Loads a short LLM-written summary for a work-log row (see Text generation model setting).
 * Returns `null` until loaded or on failure; callers should fall back to heuristic labels.
 * Persists successful lines in IndexedDB (disk-backed in the browser profile).
 */
export function useToolWorkLogFriendlyLine(
  environmentId: EnvironmentId,
  cwd: string | undefined,
  workEntry: WorkLogEntry,
): string | null {
  const modelSelection = useSettings((settings) => settings.textGenerationModelSelection);
  const toolCallSummaries = useSettings((settings) => settings.toolCallSummaries);
  const modelKey = useMemo(() => modelSelectionWireKey(modelSelection), [modelSelection]);
  const modelSelectionRef = useRef(modelSelection);
  modelSelectionRef.current = modelSelection;
  const workEntryRef = useRef(workEntry);
  workEntryRef.current = workEntry;
  const [line, setLine] = useState<string | null>(null);

  const requestSignature = useMemo(
    () =>
      JSON.stringify({
        id: workEntry.id,
        label: workEntry.label,
        toolTitle: workEntry.toolTitle,
        itemType: workEntry.itemType,
        requestKind: workEntry.requestKind,
        command: workEntry.command,
        tone: workEntry.tone,
        detailHead: workEntry.detail?.slice(0, 200) ?? null,
      }),
    [
      workEntry.id,
      workEntry.label,
      workEntry.toolTitle,
      workEntry.itemType,
      workEntry.requestKind,
      workEntry.command,
      workEntry.detail,
      workEntry.tone,
    ],
  );

  useEffect(() => {
    const workEntry = workEntryRef.current;
    const modelSelection = modelSelectionRef.current;

    if (!toolCallSummaries || !cwd || !shouldSummarizeWorkLogEntry(workEntry)) {
      setLine(null);
      return;
    }

    const key = cacheKey(environmentId, workEntry.id, modelKey);
    let cancelled = false;
    const payload = {
      cwd,
      modelSelection,
      label: workEntry.label,
      ...(workEntry.toolTitle !== undefined ? { toolTitle: workEntry.toolTitle } : {}),
      ...(workEntry.itemType !== undefined ? { itemType: workEntry.itemType } : {}),
      ...(workEntry.requestKind !== undefined ? { requestKind: workEntry.requestKind } : {}),
      ...(workEntry.command !== undefined ? { command: workEntry.command.slice(0, 2_000) } : {}),
      ...(workEntry.detail !== undefined
        ? { detailSnippet: workEntry.detail.slice(0, 3_000) }
        : {}),
    };

    void loadFriendlyLine(environmentId, key, payload)
      .then((result) => {
        if (!cancelled) {
          setLine(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLine(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, modelKey, requestSignature, toolCallSummaries]);

  return line;
}
