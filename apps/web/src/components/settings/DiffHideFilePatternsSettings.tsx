import { compileDiffHideFilePatterns } from "@t3tools/shared/changedFileKind";
import { useState } from "react";
import { useGT } from "gt-react";

import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function PatternsInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const gt = useGT();
  const [draft, setDraft] = useState(value);
  const { errors } = compileDiffHideFilePatterns(draft);

  return (
    <>
      <Textarea
        aria-label={gt("Additional hidden file patterns")}
        aria-invalid={errors.length > 0}
        aria-describedby={errors.length > 0 ? "diff-hide-patterns-error" : undefined}
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder={"(^|/)generated/\n\\.(perf|bench)\\.[^/]+$\n(^|/)benchmarks/"}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (errors.length === 0 && draft !== value) onCommit(draft);
        }}
      />
      {errors.length > 0 && (
        <p id="diff-hide-patterns-error" role="alert" className="mt-2 text-sm text-destructive">
          {gt("Line {line}: {message}. Changes have not been saved.", {
            line: errors[0]!.line,
            message: errors[0]!.message,
          })}
        </p>
      )}
    </>
  );
}

export function DiffHideFilePatternsSettings() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...setting("diff-hide-file-patterns")}
      description={gt(
        "Extend Hide test files with one RE2 pattern per line, without / delimiters. Searches full paths using /; case-sensitive by default. No lookaround or backreferences. Saves when you leave the field.",
      )}
      resetAction={
        settings.diffHideFilePatterns !== "" ? (
          <SettingResetButton
            ariaLabel={gt("Reset additional hidden file patterns")}
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
