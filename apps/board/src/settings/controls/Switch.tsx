export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-sky-500" : "bg-dot"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-fg transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}
