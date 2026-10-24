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
  onCommit: (days: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState({ source: value, text: String(value) });
  if (draft.source !== value) {
    setDraft({ source: value, text: String(value) });
  }

  return (
    <div className="w-full sm:w-24">
      <Input
        size="sm"
        type="number"
        min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        value={draft.text}
        onChange={(event) => setDraft({ source: value, text: event.target.value })}
        onBlur={async (event) => {
          const parsed = Number(event.target.value);
          if (
            Number.isInteger(parsed) &&
            parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
            parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
          ) {
            const submitted = { source: value, text: String(parsed) };
            setDraft(submitted);
            if (parsed !== value && !(await onCommit(parsed))) {
              // A late failure must not overwrite another edit or an external settings update.
              setDraft((current) =>
                current === submitted ? { source: value, text: String(value) } : current,
              );
            }
          } else {
            setDraft({ source: value, text: String(value) });
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
            setDraft({ source: value, text: String(value) });
          }
        }}
        aria-label="Days of inactivity before auto-settle"
      />
    </div>
  );
}
