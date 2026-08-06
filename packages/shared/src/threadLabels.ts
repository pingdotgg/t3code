import type { ThreadLabel } from "@t3tools/contracts";

export const THREAD_LABEL_OPTIONS: ReadonlyArray<{
  readonly value: ThreadLabel;
  readonly label: string;
}> = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
  { value: "review", label: "Review" },
  { value: "new-build", label: "New Build" },
];

export function threadLabelDisplayName(label: ThreadLabel): string {
  return THREAD_LABEL_OPTIONS.find((option) => option.value === label)?.label ?? label;
}
