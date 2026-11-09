import { useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { type RefObject, useEffect, useEffectEvent } from "react";

import { pluginComposerCollapseOnScrollAtom } from "../../plugins/pluginUi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { timelineAwayFromEndAtom } from "./useTimelineFollow";

const NEVER_AWAY_FROM_END = Atom.make(false);

/**
 * Folds the composer on wide screens while a plugin asks and the reader scrolled up this visit.
 * Folding blurs its editor, which a wide screen keeps focused while the wheel scrolls. Focusing
 * it unfolds it until the reader scrolls again. `active` is false on phones.
 */
export function useComposerCollapseOnScroll(input: {
  readonly wideScreen: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly formRef: RefObject<HTMLFormElement | null>;
  /** False while a multi-line prompt, a question or a forced expansion keeps it open. */
  readonly canFold: boolean;
  readonly focused: boolean;
}) {
  const requested = useAtomValue(pluginComposerCollapseOnScrollAtom);
  const active = requested && input.wideScreen;
  // Followed even while narrow, so a window widened while scrolled up folds at once.
  const awayAtom = requested
    ? timelineAwayFromEndAtom(scopedThreadKey(input.threadRef))
    : NEVER_AWAY_FROM_END;
  useAtomSubscribe(awayAtom, (away) => {
    const focused = document.activeElement;
    if (
      away &&
      active &&
      input.canFold &&
      focused instanceof HTMLElement &&
      focused.isContentEditable &&
      input.formRef.current?.contains(focused)
    ) {
      focused.blur();
    }
  });
  const awayFromEnd = useAtomValue(awayAtom);
  // On the focus itself, not the focused state, since a fold blurs the editor only a frame later.
  const unfold = useEffectEvent(() => {
    if (active && appAtomRegistry.get(awayAtom)) appAtomRegistry.set(awayAtom, false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the timeline the reader reopened the composer, so only their next scroll folds it again
  useEffect(() => {
    if (input.focused) unfold();
  }, [input.focused]);
  return { active, awayFromEnd: active && awayFromEnd };
}
