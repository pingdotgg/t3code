import { useState } from "react";
import { normalizeProviderIconUrl, type ProviderDriverKind } from "@t3tools/contracts";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

export function ProviderIconUrlInput(props: {
  readonly value: string | undefined;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly disabled?: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<{ saved: string | undefined; value: string } | null>(null);
  const value = draft !== null && draft.saved === props.value ? draft.value : (props.value ?? "");
  const invalid = value.trim() !== "" && normalizeProviderIconUrl(value) === null;
  const commit = () => {
    const next = normalizeProviderIconUrl(value) ?? "";
    if (!invalid && next !== (props.value ?? "")) props.onCommit(next);
  };
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-2">
        <ProviderInstanceIcon
          driverKind={props.driverKind}
          displayName={props.displayName}
          iconUrl={props.value}
        />
        <Input
          aria-label="Instance icon URL"
          aria-invalid={invalid || undefined}
          size="sm"
          type="url"
          value={value}
          placeholder="https://example.com/icon.png"
          disabled={props.disabled}
          spellCheck={false}
          onChange={(event) => setDraft({ saved: props.value, value: event.target.value })}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={props.disabled || !value}
          onClick={() => {
            setDraft(null);
            props.onCommit("");
          }}
        >
          Reset
        </Button>
      </div>
      {invalid ? (
        <p className="text-xs text-destructive">Enter an HTTPS image URL without credentials.</p>
      ) : null}
    </div>
  );
}
