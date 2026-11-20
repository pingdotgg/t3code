import { fieldClass } from "./fieldClass";

export function Select<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly title: string }>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = options.find((option) => option.value === event.target.value);
        if (next) onChange(next.value);
      }}
      className={`${fieldClass} cursor-pointer`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.title}
        </option>
      ))}
    </select>
  );
}
