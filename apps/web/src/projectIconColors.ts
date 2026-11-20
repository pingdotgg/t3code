import type { ProjectIconColor } from "@t3tools/contracts";
import { msg } from "gt-react";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  /** Text shades that keep a project title at 4.5:1 or better on the sidebar. */
  readonly titleClassName: string;
  readonly swatchClassName: string;
}> = [
  {
    value: "gray",
    label: msg("Gray", { $context: "colour name, project icon colour" }),
    className: "text-gray-600 dark:text-gray-400",
    titleClassName: "text-gray-700 dark:text-gray-400",
    swatchClassName: "bg-gray-500",
  },
  {
    value: "red",
    label: msg("Red", { $context: "colour name, project icon colour" }),
    className: "text-red-600 dark:text-red-400",
    titleClassName: "text-red-700 dark:text-red-400",
    swatchClassName: "bg-red-500",
  },
  {
    value: "orange",
    label: msg("Orange", { $context: "colour name, project icon colour" }),
    className: "text-orange-600 dark:text-orange-400",
    titleClassName: "text-orange-700 dark:text-orange-400",
    swatchClassName: "bg-orange-500",
  },
  {
    value: "amber",
    label: msg("Amber", { $context: "colour name, project icon colour" }),
    className: "text-amber-600 dark:text-amber-400",
    titleClassName: "text-amber-700 dark:text-amber-400",
    swatchClassName: "bg-amber-500",
  },
  {
    value: "yellow",
    label: msg("Yellow", { $context: "colour name, project icon colour" }),
    className: "text-yellow-600 dark:text-yellow-400",
    titleClassName: "text-yellow-700 dark:text-yellow-400",
    swatchClassName: "bg-yellow-500",
  },
  {
    value: "lime",
    label: msg("Lime", { $context: "colour name, project icon colour" }),
    className: "text-lime-600 dark:text-lime-400",
    titleClassName: "text-lime-700 dark:text-lime-400",
    swatchClassName: "bg-lime-500",
  },
  {
    value: "green",
    label: msg("Green", { $context: "colour name, project icon colour" }),
    className: "text-green-600 dark:text-green-400",
    titleClassName: "text-green-700 dark:text-green-400",
    swatchClassName: "bg-green-500",
  },
  {
    value: "emerald",
    label: msg("Emerald", { $context: "colour name, project icon colour" }),
    className: "text-emerald-600 dark:text-emerald-400",
    titleClassName: "text-emerald-700 dark:text-emerald-400",
    swatchClassName: "bg-emerald-500",
  },
  {
    value: "teal",
    label: msg("Teal", { $context: "colour name, project icon colour" }),
    className: "text-teal-600 dark:text-teal-400",
    titleClassName: "text-teal-700 dark:text-teal-400",
    swatchClassName: "bg-teal-500",
  },
  {
    value: "cyan",
    label: msg("Cyan", { $context: "colour name, project icon colour" }),
    className: "text-cyan-600 dark:text-cyan-400",
    titleClassName: "text-cyan-700 dark:text-cyan-400",
    swatchClassName: "bg-cyan-500",
  },
  {
    value: "sky",
    label: msg("Sky", { $context: "colour name, project icon colour" }),
    className: "text-sky-600 dark:text-sky-400",
    titleClassName: "text-sky-700 dark:text-sky-400",
    swatchClassName: "bg-sky-500",
  },
  {
    value: "blue",
    label: msg("Blue", { $context: "colour name, project icon colour" }),
    className: "text-blue-600 dark:text-blue-400",
    titleClassName: "text-blue-700 dark:text-blue-400",
    swatchClassName: "bg-blue-500",
  },
  {
    value: "indigo",
    label: msg("Indigo", { $context: "colour name, project icon colour" }),
    className: "text-indigo-600 dark:text-indigo-400",
    titleClassName: "text-indigo-700 dark:text-indigo-400",
    swatchClassName: "bg-indigo-500",
  },
  {
    value: "violet",
    label: msg("Violet", { $context: "colour name, project icon colour" }),
    className: "text-violet-600 dark:text-violet-400",
    titleClassName: "text-violet-700 dark:text-violet-400",
    swatchClassName: "bg-violet-500",
  },
  {
    value: "purple",
    label: msg("Purple", { $context: "colour name, project icon colour" }),
    className: "text-purple-600 dark:text-purple-400",
    titleClassName: "text-purple-700 dark:text-purple-400",
    swatchClassName: "bg-purple-500",
  },
  {
    value: "fuchsia",
    label: msg("Fuchsia", { $context: "colour name, project icon colour" }),
    className: "text-fuchsia-600 dark:text-fuchsia-400",
    titleClassName: "text-fuchsia-700 dark:text-fuchsia-400",
    swatchClassName: "bg-fuchsia-500",
  },
  {
    value: "pink",
    label: msg("Pink", { $context: "colour name, project icon colour" }),
    className: "text-pink-600 dark:text-pink-400",
    titleClassName: "text-pink-700 dark:text-pink-400",
    swatchClassName: "bg-pink-500",
  },
  {
    value: "rose",
    label: msg("Rose", { $context: "colour name, project icon colour" }),
    className: "text-rose-600 dark:text-rose-400",
    titleClassName: "text-rose-700 dark:text-rose-400",
    swatchClassName: "bg-rose-500",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}

const PROJECT_TITLE_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, titleClassName }) => [value, titleClassName]),
) as Record<ProjectIconColor, string>;

export function projectTitleColorClassName(color: ProjectIconColor): string {
  return PROJECT_TITLE_COLOR_CLASSES[color];
}
