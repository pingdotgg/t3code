import { compileDiffHideFilePatterns } from "@t3tools/shared/changedFileKind";
import { useState } from "react";

import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function PatternsInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const { errors } = compileDiffHideFilePatterns(draft);

  return (
    <>
      <Textarea
        aria-label="Additional hidden file patterns"
        aria-invalid={errors.length > 0}
        aria-describedby={errors.length > 0 ? "diff-hide-patterns-error" : undefined}
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder={"\\.stories\\.tsx$\n\\.(perf|bench)\\.[^/]+$\n(^|/)benchmarks/"}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (errors.length === 0 && draft !== value) onCommit(draft);
        }}
      />
      {errors.length > 0 && (
        <p id="diff-hide-patterns-error" role="alert" className="mt-2 text-sm text-destructive">
          Line {errors[0]!.line}: {errors[0]!.message}. Changes have not been saved.
        </p>
      )}
    </>
  );
}

export function DiffHideFilePatternsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("diff-hide-file-patterns")}
      description="Extend Hide test files with one RE2 pattern per line, without / delimiters. Searches full paths using /; case-sensitive by default. No lookaround or backreferences. Saves when you leave the field."
      resetAction={
        settings.diffHideFilePatterns !== "" ? (
          <SettingResetButton
            label="additional hidden file patterns"
            onClick={() => updateSettings({ diffHideFilePatterns: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <PatternsInput
          key={settings.diffHideFilePatterns}
          value={settings.diffHideFilePatterns}
          onCommit={(diffHideFilePatterns) => updateSettings({ diffHideFilePatterns })}
        />
      </div>
    </SettingsRow>
  );
}
