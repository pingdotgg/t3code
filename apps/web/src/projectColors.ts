import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./logicalProject";

/**
 * Palette for per-project accessibility colors.
 *
 * Colors are persisted as palette names (not raw hex) so swatches resolve
 * through the theme's Tailwind color tokens and stay legible in both light
 * and dark appearances. The server treats the value as an opaque string, so
 * unknown values (from newer clients) simply render without a swatch here.
 */
export const PROJECT_COLOR_OPTIONS = [
  { name: "red", label: "Red" },
  { name: "orange", label: "Orange" },
  { name: "amber", label: "Amber" },
  { name: "green", label: "Green" },
  { name: "teal", label: "Teal" },
  { name: "sky", label: "Sky" },
  { name: "blue", label: "Blue" },
  { name: "violet", label: "Violet" },
  { name: "pink", label: "Pink" },
] as const;

export type ProjectColorName = (typeof PROJECT_COLOR_OPTIONS)[number]["name"];

/**
 * Literal var() strings (never built dynamically): Tailwind v4 only emits
 * theme variables it can detect in scanned source, so the palette must
 * reference each `--color-*-500` token verbatim somewhere this feature owns.
 */
export const PROJECT_COLOR_VALUES: Record<ProjectColorName, string> = {
  red: "var(--color-red-500)",
  orange: "var(--color-orange-500)",
  amber: "var(--color-amber-500)",
  green: "var(--color-green-500)",
  teal: "var(--color-teal-500)",
  sky: "var(--color-sky-500)",
  blue: "var(--color-blue-500)",
  violet: "var(--color-violet-500)",
  pink: "var(--color-pink-500)",
};

export function isProjectColorName(value: string): value is ProjectColorName {
  return value in PROJECT_COLOR_VALUES;
}

/**
 * CSS color for a stored project color, or null when nothing should render
 * (no color set, or a value this client doesn't understand).
 */
export function projectColorCssValue(color: string | null | undefined): string | null {
  if (!color) {
    return null;
  }
  if (isProjectColorName(color)) {
    return PROJECT_COLOR_VALUES[color];
  }
  return /^#[0-9a-fA-F]{6}$/u.test(color) ? color : null;
}

/**
 * The color a grouped sidebar project should display: the representative's
 * own color when set (the group snapshot carries the representative's
 * fields), otherwise the first member that has one — so a color chosen in
 * any environment identifies the whole group, without a remote member
 * overriding a colored representative.
 */
export function resolveProjectGroupColor(group: {
  readonly color?: string | null | undefined;
  readonly memberProjects: ReadonlyArray<{ readonly color?: string | null | undefined }>;
}): string | null {
  if (group.color) {
    return group.color;
  }
  for (const member of group.memberProjects) {
    if (member.color) {
      return member.color;
    }
  }
  return null;
}

/**
 * Group color for one physical project, using the same grouping the sidebar
 * renders — so surfaces that only know the active project (e.g. the chat
 * header) agree with the sidebar when the color was set on a different
 * member of the same logical project.
 */
export function resolveProjectColorInGroups(input: {
  readonly project: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly settings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): string | null {
  if (input.project.color) {
    return input.project.color;
  }
  const physicalKey = derivePhysicalProjectKey(input.project);
  const group = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).find((candidate) =>
    candidate.members.some((member) => member.physicalProjectKey === physicalKey),
  );
  if (!group) {
    return null;
  }
  return resolveProjectGroupColor({
    color: group.representative.color ?? null,
    memberProjects: group.members.map((member) => member.project),
  });
}
