import { useMemo, useState } from "react";

import { collectComposerModelTokens } from "../lib/composerContext";
import type { SelectableMarkdownModel } from "./SelectableMarkdownText.types";

/** Render-phase state, like the editors' inline tokens, so an abandoned render leaves no chip behind. */
export function useComposerModelTokens(
  value: string,
  models: ReadonlyArray<SelectableMarkdownModel>,
) {
  const modelsBySource = useMemo(
    () => new Map(models.map((model) => [model.source, model])),
    [models],
  );
  const [confirmed, setConfirmed] = useState(() => ({
    value,
    modelsBySource,
    tokens: collectComposerModelTokens(value, modelsBySource),
  }));
  let tokens = confirmed.tokens;
  if (confirmed.value !== value || confirmed.modelsBySource !== modelsBySource) {
    tokens = collectComposerModelTokens(value, modelsBySource, confirmed.tokens);
    setConfirmed({ value, modelsBySource, tokens });
  }
  return { modelsBySource, modelTokens: tokens };
}
