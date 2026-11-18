export function laterMenuItem(input: { readonly label: string; readonly disabled: boolean }) {
  return {
    id: "snooze:someday" as const,
    label: input.label,
    icon: "clock",
    disabled: input.disabled,
  };
}
