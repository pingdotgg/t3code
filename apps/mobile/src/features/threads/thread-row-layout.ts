import { useAtomValue } from "@effect/atom-react";
import {
  MOBILE_DEFAULT_STORED_LAYOUT,
  resolveSidebarRowLayout,
  withoutSidebarRowItem,
} from "@t3tools/client-runtime/thread-row-layout";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

const EMPTY_LAYOUT = {};

/** The thread list card layout saved on this device, resolved against mobile's defaults. */
export function useThreadRowLayout() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadRowLayout ?? EMPTY_LAYOUT)
    : EMPTY_LAYOUT;
  // The thread list does not track terminals, so the item never takes a line here.
  return withoutSidebarRowItem(
    resolveSidebarRowLayout(stored, MOBILE_DEFAULT_STORED_LAYOUT),
    "terminals",
  );
}
