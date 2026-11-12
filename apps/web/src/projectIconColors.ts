import type { ProjectIconColor } from "@t3tools/contracts";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  readonly swatchClassName: string;
  readonly tintClassName: string;
}> = [
  {
    value: "gray",
    label: "Gray",
    className: "text-gray-600 dark:text-gray-400",
    swatchClassName: "bg-gray-500",
    tintClassName: "bg-gray-500/[0.09] dark:bg-gray-400/[0.11]",
  },
  {
    value: "red",
    label: "Red",
    className: "text-red-600 dark:text-red-400",
    swatchClassName: "bg-red-500",
    tintClassName: "bg-red-500/[0.09] dark:bg-red-400/[0.11]",
  },
  {
    value: "orange",
    label: "Orange",
    className: "text-orange-600 dark:text-orange-400",
    swatchClassName: "bg-orange-500",
    tintClassName: "bg-orange-500/[0.09] dark:bg-orange-400/[0.11]",
  },
  {
    value: "amber",
    label: "Amber",
    className: "text-amber-600 dark:text-amber-400",
    swatchClassName: "bg-amber-500",
    tintClassName: "bg-amber-500/[0.09] dark:bg-amber-400/[0.11]",
  },
  {
    value: "yellow",
    label: "Yellow",
    className: "text-yellow-600 dark:text-yellow-400",
    swatchClassName: "bg-yellow-500",
    tintClassName: "bg-yellow-500/[0.09] dark:bg-yellow-400/[0.11]",
  },
  {
    value: "lime",
    label: "Lime",
    className: "text-lime-600 dark:text-lime-400",
    swatchClassName: "bg-lime-500",
    tintClassName: "bg-lime-500/[0.09] dark:bg-lime-400/[0.11]",
  },
  {
    value: "green",
    label: "Green",
    className: "text-green-600 dark:text-green-400",
    swatchClassName: "bg-green-500",
    tintClassName: "bg-green-500/[0.09] dark:bg-green-400/[0.11]",
  },
  {
    value: "emerald",
    label: "Emerald",
    className: "text-emerald-600 dark:text-emerald-400",
    swatchClassName: "bg-emerald-500",
    tintClassName: "bg-emerald-500/[0.09] dark:bg-emerald-400/[0.11]",
  },
  {
    value: "teal",
    label: "Teal",
    className: "text-teal-600 dark:text-teal-400",
    swatchClassName: "bg-teal-500",
    tintClassName: "bg-teal-500/[0.09] dark:bg-teal-400/[0.11]",
  },
  {
    value: "cyan",
    label: "Cyan",
    className: "text-cyan-600 dark:text-cyan-400",
    swatchClassName: "bg-cyan-500",
    tintClassName: "bg-cyan-500/[0.09] dark:bg-cyan-400/[0.11]",
  },
  {
    value: "sky",
    label: "Sky",
    className: "text-sky-600 dark:text-sky-400",
    swatchClassName: "bg-sky-500",
    tintClassName: "bg-sky-500/[0.09] dark:bg-sky-400/[0.11]",
  },
  {
    value: "blue",
    label: "Blue",
    className: "text-blue-600 dark:text-blue-400",
    swatchClassName: "bg-blue-500",
    tintClassName: "bg-blue-500/[0.09] dark:bg-blue-400/[0.11]",
  },
  {
    value: "indigo",
    label: "Indigo",
    className: "text-indigo-600 dark:text-indigo-400",
    swatchClassName: "bg-indigo-500",
    tintClassName: "bg-indigo-500/[0.09] dark:bg-indigo-400/[0.11]",
  },
  {
    value: "violet",
    label: "Violet",
    className: "text-violet-600 dark:text-violet-400",
    swatchClassName: "bg-violet-500",
    tintClassName: "bg-violet-500/[0.09] dark:bg-violet-400/[0.11]",
  },
  {
    value: "purple",
    label: "Purple",
    className: "text-purple-600 dark:text-purple-400",
    swatchClassName: "bg-purple-500",
    tintClassName: "bg-purple-500/[0.09] dark:bg-purple-400/[0.11]",
  },
  {
    value: "fuchsia",
    label: "Fuchsia",
    className: "text-fuchsia-600 dark:text-fuchsia-400",
    swatchClassName: "bg-fuchsia-500",
    tintClassName: "bg-fuchsia-500/[0.09] dark:bg-fuchsia-400/[0.11]",
  },
  {
    value: "pink",
    label: "Pink",
    className: "text-pink-600 dark:text-pink-400",
    swatchClassName: "bg-pink-500",
    tintClassName: "bg-pink-500/[0.09] dark:bg-pink-400/[0.11]",
  },
  {
    value: "rose",
    label: "Rose",
    className: "text-rose-600 dark:text-rose-400",
    swatchClassName: "bg-rose-500",
    tintClassName: "bg-rose-500/[0.09] dark:bg-rose-400/[0.11]",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}

const PROJECT_ICON_TINT_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, tintClassName }) => [value, tintClassName]),
) as Record<ProjectIconColor, string>;

export function projectIconTintClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_TINT_CLASSES[color];
}
