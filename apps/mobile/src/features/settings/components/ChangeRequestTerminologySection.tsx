import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { useChangeRequestTerms } from "../../../state/change-request-terminology";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function ChangeRequestTerminologySection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const terms = useChangeRequestTerms();

  return (
    <SettingsSection title="Terminology">
      <SettingsSwitchRow
        icon={PullRequestGlyph.pullRequest}
        label="Use merge request terminology"
        subtitle="Say “merge request” and “MR” instead of “pull request” and “PR” on this device, for every host."
        disabled={!AsyncResult.isSuccess(preferences)}
        value={terms.shortLabel === "MR"}
        onValueChange={(mergeRequestTerminology) => savePreferences({ mergeRequestTerminology })}
      />
    </SettingsSection>
  );
}
