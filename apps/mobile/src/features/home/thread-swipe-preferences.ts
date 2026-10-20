import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  DEFAULT_THREAD_SWIPE_LEADING_ACTION,
  DEFAULT_THREAD_SWIPE_TRAILING_ACTION,
} from "../../lib/threadSwipeAction";
import { mobilePreferencesAtom } from "../../state/preferences";

// Primitive-valued atoms so rows re-render only when their own side changes,
// not on every unrelated preference write.
const threadSwipeLeadingActionAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadSwipeLeadingAction ?? DEFAULT_THREAD_SWIPE_LEADING_ACTION)
    : DEFAULT_THREAD_SWIPE_LEADING_ACTION;
});

const threadSwipeTrailingActionAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadSwipeTrailingAction ?? DEFAULT_THREAD_SWIPE_TRAILING_ACTION)
    : DEFAULT_THREAD_SWIPE_TRAILING_ACTION;
});

export function useThreadSwipeActionChoices() {
  return {
    leading: useAtomValue(threadSwipeLeadingActionAtom),
    trailing: useAtomValue(threadSwipeTrailingActionAtom),
  };
}
