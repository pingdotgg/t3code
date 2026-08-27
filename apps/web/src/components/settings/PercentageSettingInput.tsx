import { DraftInput } from "../ui/draft-input";

type PercentageSettingInputProps = {
  readonly ariaLabel: string;
  readonly max: number;
  readonly min: number;
  readonly onCommit: (value: number) => void;
  readonly value: number;
};

export function parsePercentageSettingValue(
  value: string,
  min: number,
  max: number,
): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function PercentageSettingInput({
  ariaLabel,
  max,
  min,
  onCommit,
  value,
}: PercentageSettingInputProps) {
  return (
    <div className="relative w-16 shrink-0">
      <DraftInput
        aria-label={ariaLabel}
        autoComplete="off"
        className="font-mono text-xs font-medium tabular-nums [&_input]:pe-6 [&_input]:text-right"
        inputMode="numeric"
        maxLength={String(max).length}
        onCommit={(draft) => {
          const parsed = parsePercentageSettingValue(draft, min, max);
          if (parsed !== null) onCommit(parsed);
        }}
        pattern="[0-9]*"
        size="compact"
        spellCheck={false}
        value={String(value)}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 end-2 flex items-center font-mono text-xs font-medium text-muted-foreground"
      >
        %
      </span>
    </div>
  );
}
