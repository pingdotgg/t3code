import type { IdleCompactionMode } from "@t3tools/contracts";
import { useState } from "react";

export function useResumeCompactionSelection(mode: IdleCompactionMode, threadKey: string) {
  const defaultKeepFullHistory = mode === "suggestOnReturn";
  const [selections, setSelections] = useState(
    () => new Map([[threadKey, { mode, keepFullHistory: defaultKeepFullHistory, generation: 0 }]]),
  );
  const selection = selections.get(threadKey);
  const generation =
    (selection?.generation ?? 0) + (selection !== undefined && selection.mode !== mode ? 1 : 0);
  if (selection === undefined || selection.mode !== mode) {
    setSelections(
      new Map(selections).set(threadKey, {
        mode,
        keepFullHistory: defaultKeepFullHistory,
        generation,
      }),
    );
  }

  const keepFullHistory =
    selection?.mode === mode ? selection.keepFullHistory : defaultKeepFullHistory;
  const setKeepFullHistory = (keep: boolean) => {
    setSelections((current) => {
      const selection = current.get(threadKey);
      // A completed send must not clear a newer mode or manual choice.
      if (selection?.mode !== mode || selection.generation !== generation) return current;
      if (selection.keepFullHistory === keep) return current;
      return new Map(current).set(threadKey, {
        ...selection,
        keepFullHistory: keep,
        generation: generation + 1,
      });
    });
  };

  return { keepFullHistory, setKeepFullHistory, defaultKeepFullHistory };
}
