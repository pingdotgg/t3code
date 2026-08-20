import type { EnvironmentId, ProviderInteractionMode } from "@t3tools/contracts";
import { detectComposerTrigger, type ComposerTrigger } from "@t3tools/shared/composerTrigger";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import {
  buildComposerMenuItems,
  nextComposerSelection,
  resolveComposerCommandSelection,
  type ComposerBuiltInCommand,
  type ComposerTriggerMenuProvider,
} from "./composer-trigger-menu";

export interface ComposerTriggerMenu {
  readonly trigger: ComposerTrigger | null;
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly isLoading: boolean;
  /** Controlled editor selection; the hook moves the caret after an insert. */
  readonly selection: ComposerEditorSelection;
  readonly onSelectionChange: (selection: ComposerEditorSelection) => void;
  readonly onSelect: (item: ComposerCommandItem) => void;
}

/**
 * Owns the `$` / `/` / `@` composer trigger menu: caret tracking, trigger
 * detection, the path search for the target project, and insertion.
 *
 * Shared by the thread composer and the new-task draft composer so both
 * surfaces run one implementation. `builtInCommands` and `resetKey` are the
 * per-surface knobs; pass a stable `builtInCommands` reference.
 */
export function useComposerTriggerMenu(input: {
  readonly text: string;
  readonly environmentId: EnvironmentId | null;
  /** Directory the `@` search runs in — the project the composer targets. */
  readonly projectCwd: string | null;
  readonly provider: ComposerTriggerMenuProvider | null;
  readonly builtInCommands: ReadonlyArray<ComposerBuiltInCommand>;
  /**
   * Identity of the draft being edited. Changing it parks the caret at the end
   * of the newly loaded text. Omit it only on surfaces that really do remount
   * per draft. The thread composer omits it and leans on that, which does not
   * hold on tablet split view: there `resolveThreadSelectionNavigationAction`
   * returns `"set-params"`, so picking another thread renavigates the same
   * route instance and the composer keeps the previous thread's caret.
   */
  readonly resetKey?: string | null;
  readonly onChangeText: (value: string) => void;
  readonly onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
}): ComposerTriggerMenu {
  const { builtInCommands, onChangeText, onSelectInteractionMode, provider, resetKey, text } =
    input;
  const [selection, setSelection] = useState<ComposerEditorSelection>(() => ({
    start: text.length,
    end: text.length,
  }));

  // Adjusted while rendering, not in an effect: the composer must never render
  // once with the previous draft's caret, or the trigger popover flashes open
  // and fires a path search the user never asked for.
  const lastResetKeyRef = useRef(resetKey);
  if (lastResetKeyRef.current !== resetKey) {
    lastResetKeyRef.current = resetKey;
    setSelection((current) =>
      nextComposerSelection({ current, textLength: text.length, draftChanged: true }),
    );
  }

  const onSelectionChange = useCallback((next: ComposerEditorSelection) => {
    setSelection(next);
  }, []);

  useEffect(() => {
    const textLength = text.length;
    setSelection((current) => nextComposerSelection({ current, textLength, draftChanged: false }));
  }, [text.length]);

  const trigger = useMemo<ComposerTrigger | null>(() => {
    if (selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(text, selection.end);
  }, [selection, text]);

  const pathSearch = useComposerPathSearch({
    environmentId: input.environmentId,
    cwd: trigger?.kind === "path" ? input.projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });

  const items = useMemo(
    () =>
      buildComposerMenuItems({
        trigger,
        provider,
        builtInCommands,
        pathEntries: pathSearch.entries,
      }),
    [builtInCommands, pathSearch.entries, provider, trigger],
  );

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;
      const result = resolveComposerCommandSelection({ text, trigger, item });
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeText(result.text);
      if (result.interactionMode !== null) {
        onSelectInteractionMode(result.interactionMode);
      }
    },
    [onChangeText, onSelectInteractionMode, text, trigger],
  );

  return {
    trigger,
    items,
    isLoading: pathSearch.isPending,
    selection,
    onSelectionChange,
    onSelect,
  };
}
