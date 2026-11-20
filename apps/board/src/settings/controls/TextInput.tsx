import { fieldClass } from "./fieldClass";

// The field holds its own draft and remounts when the saved value changes, so a save the engine
// normalized, or one that failed, never leaves stale text behind.
export function TextInput({
  label,
  value,
  placeholder,
  className = "w-72",
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (value: string) => void;
}) {
  return (
    <input
      key={value}
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="none"
      onBlur={(event) => {
        if (event.target.value !== value) onCommit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={`${fieldClass} ${className}`}
    />
  );
}
