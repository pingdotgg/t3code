import { useAtomValue } from "@effect/atom-react";
import {
  issuePropertyPinKey,
  toggleIssuePropertyPin,
} from "@t3tools/client-runtime/issue-properties";
import type { IssueDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

/** The fields pinned to one issue's overview on this device. */
export function useIssuePropertyPins(issue: IssueDetail | null) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const key = issue === null ? null : issuePropertyPinKey(issue);
  // Until the stored pins load, a toggle would write over them.
  const ready = AsyncResult.isSuccess(preferences);
  return {
    ids: ready && key !== null ? (preferences.value.issuePropertyPins?.[key] ?? []) : [],
    ready,
    toggle: (propertyId: string) => {
      if (!ready || key === null) return;
      void save({
        transform: (current) => ({
          issuePropertyPins: toggleIssuePropertyPin(
            current.issuePropertyPins ?? {},
            key,
            propertyId,
          ),
        }),
      });
    },
  };
}
