export interface NumberFieldProps {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly formatValue?: (value: number) => string;
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly disabled?: boolean;
}
