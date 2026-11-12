import { useState } from "react";
import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";
import { Input } from "../ui/input";

export function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number, options: { onFailed: () => void }) => void;
}) {
  const saved = { source: value, text: String(value), submitted: value };
  const [draft, setDraft] = useState(saved);
  if (draft.source !== value) {
    setDraft(saved);
  }

  return (
    <div className="w-full sm:w-24">
      <Input
        size="sm"
        type="number"
        min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onBlur={(event) => {
          const parsed = Number(event.target.value);
          if (
            Number.isInteger(parsed) &&
            parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
            parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
          ) {
            // Compare with the last submission, not the prop: a pending save has not landed yet.
            if (parsed === draft.submitted) {
              setDraft({ ...draft, text: String(parsed) });
              return;
            }
            const submitted = { source: value, text: String(parsed), submitted: parsed };
            setDraft(submitted);
            onCommit(parsed, {
              // A late failure must not overwrite another edit or an external settings update.
              onFailed: () => setDraft((current) => (current === submitted ? saved : current)),
            });
          } else {
            setDraft({ ...draft, text: String(draft.submitted) });
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft({ ...draft, text: String(draft.submitted) });
          }
        }}
        aria-label="Days of inactivity before auto-settle"
      />
    </div>
  );
}
