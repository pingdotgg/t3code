import { fieldClass } from "./fieldClass";

export function TextArea({
  label,
  value,
  placeholder,
  mono,
  rows = 4,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  rows?: number;
  onCommit: (value: string) => void;
}) {
  return (
    <textarea
      key={value}
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
      onBlur={(event) => {
        if (event.target.value !== value) onCommit(event.target.value);
      }}
      className={`${fieldClass} w-full resize-y leading-relaxed ${mono ? "font-mono text-xs" : ""}`}
    />
  );
}
