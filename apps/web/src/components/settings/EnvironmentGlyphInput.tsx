import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { normalizeEnvironmentGlyph, useEnvironmentGlyphStore } from "~/environmentGlyphStore";
import { Input } from "../ui/input";

/** Edit the local glyph without changing the server-backed machine icon. */
export function EnvironmentGlyphInput({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const [draft, setDraft] = useState(
    () => useEnvironmentGlyphStore.getState().byId[environmentId] ?? "",
  );
  const composing = useRef(false);
  const setGlyph = (value: string) => {
    useEnvironmentGlyphStore.getState().setGlyph(environmentId, value);
  };

  const finish = (value: string) => {
    composing.current = false;
    const normalized = normalizeEnvironmentGlyph(value) ?? "";
    setDraft(normalized);
    setGlyph(normalized);
  };

  return (
    <div className="w-12 shrink-0 text-center">
      <Input
        aria-label={`Badge glyph for ${label}`}
        title="One character or emoji (this device only). Clear to use the machine icon."
        value={draft}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setDraft(value);
          if (!composing.current) setGlyph(value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const value = event.currentTarget.value;
          setDraft(value);
          setGlyph(value);
        }}
        onBlur={(event) => finish(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !composing.current && !event.nativeEvent.isComposing) {
            event.currentTarget.blur();
          }
        }}
        placeholder="α"
        size="sm"
      />
    </div>
  );
}
