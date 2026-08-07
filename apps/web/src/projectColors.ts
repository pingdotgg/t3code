/**
 * Preset accent colors a user can assign to a project. The contract stores the
 * color as a free-form token so the palette can evolve without breaking older
 * clients; unknown tokens simply render as "no color".
 */
export interface ProjectColorOption {
  readonly value: string;
  readonly label: string;
  readonly cssColor: string;
}

export const PROJECT_COLOR_OPTIONS: readonly ProjectColorOption[] = [
  { value: "red", label: "Red", cssColor: "#ef4444" },
  { value: "orange", label: "Orange", cssColor: "#f97316" },
  { value: "amber", label: "Amber", cssColor: "#f59e0b" },
  { value: "green", label: "Green", cssColor: "#22c55e" },
  { value: "teal", label: "Teal", cssColor: "#14b8a6" },
  { value: "blue", label: "Blue", cssColor: "#3b82f6" },
  { value: "violet", label: "Violet", cssColor: "#8b5cf6" },
  { value: "pink", label: "Pink", cssColor: "#ec4899" },
];

export function resolveProjectColorCss(color: string | null | undefined): string | null {
  if (!color) return null;
  return PROJECT_COLOR_OPTIONS.find((option) => option.value === color)?.cssColor ?? null;
}

/**
 * Display color for a project group: the first member with a recognized color
 * wins, so grouped projects stay stable when only some members are colored.
 */
export function resolveProjectGroupColorCss(
  members: ReadonlyArray<{ readonly color?: string | null | undefined }>,
): string | null {
  for (const member of members) {
    const cssColor = resolveProjectColorCss(member.color);
    if (cssColor) return cssColor;
  }
  return null;
}
