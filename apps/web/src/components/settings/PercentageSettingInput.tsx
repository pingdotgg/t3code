import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";

type PercentageSettingInputProps = {
  readonly ariaLabel: string;
  readonly max: number;
  readonly min: number;
  readonly onCommit: (value: number) => void;
  readonly value: number;
};

const PERCENT_FORMAT = {
  maximumFractionDigits: 0,
  style: "unit",
  unit: "percent",
  useGrouping: false,
} satisfies Intl.NumberFormatOptions;

export function PercentageSettingInput({
  ariaLabel,
  max,
  min,
  onCommit,
  value,
}: PercentageSettingInputProps) {
  return (
    <NumberField
      className="w-16 shrink-0 gap-0"
      format={PERCENT_FORMAT}
      max={max}
      min={min}
      onValueCommitted={(nextValue) => {
        if (nextValue === null) return;
        onCommit(Math.min(max, Math.max(min, nextValue)));
      }}
      size="sm"
      step={1}
      value={value}
    >
      <NumberFieldGroup>
        <NumberFieldInput
          aria-label={ariaLabel}
          className="font-mono text-xs font-medium tabular-nums"
        />
      </NumberFieldGroup>
    </NumberField>
  );
}
