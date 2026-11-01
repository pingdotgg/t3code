import type { ProjectIconColor } from "@t3tools/contracts";

// Desaturated hues so a column of project tiles reads as one calm set rather
// than a row of saturated badges. Light values are darkened for contrast on white.
export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  readonly swatchClassName: string;
}> = [
  {
    value: "gray",
    label: "Gray",
    className: "text-[#6b7380] dark:text-[#8c95a3]",
    swatchClassName: "bg-[#8c95a3]",
  },
  {
    value: "red",
    label: "Red",
    className: "text-[#a94f4f] dark:text-[#c86b6b]",
    swatchClassName: "bg-[#c86b6b]",
  },
  {
    value: "orange",
    label: "Orange",
    className: "text-[#b06d3b] dark:text-[#d08b5a]",
    swatchClassName: "bg-[#d08b5a]",
  },
  {
    value: "amber",
    label: "Amber",
    className: "text-[#a47a34] dark:text-[#c99a52]",
    swatchClassName: "bg-[#c99a52]",
  },
  {
    value: "yellow",
    label: "Yellow",
    className: "text-[#96863a] dark:text-[#bfae55]",
    swatchClassName: "bg-[#bfae55]",
  },
  {
    value: "lime",
    label: "Lime",
    className: "text-[#7b8d3e] dark:text-[#9fb060]",
    swatchClassName: "bg-[#9fb060]",
  },
  {
    value: "green",
    label: "Green",
    className: "text-[#6a8349] dark:text-[#8fa66f]",
    swatchClassName: "bg-[#8fa66f]",
  },
  {
    value: "emerald",
    label: "Emerald",
    className: "text-[#4f8a6b] dark:text-[#6fa88a]",
    swatchClassName: "bg-[#6fa88a]",
  },
  {
    value: "teal",
    label: "Teal",
    className: "text-[#41857e] dark:text-[#5fa39b]",
    swatchClassName: "bg-[#5fa39b]",
  },
  {
    value: "cyan",
    label: "Cyan",
    className: "text-[#43859a] dark:text-[#62a3b4]",
    swatchClassName: "bg-[#62a3b4]",
  },
  {
    value: "sky",
    label: "Sky",
    className: "text-[#4c7aab] dark:text-[#6b9ac9]",
    swatchClassName: "bg-[#6b9ac9]",
  },
  {
    value: "blue",
    label: "Blue",
    className: "text-[#4d70ab] dark:text-[#6b8fc9]",
    swatchClassName: "bg-[#6b8fc9]",
  },
  {
    value: "indigo",
    label: "Indigo",
    className: "text-[#6166ab] dark:text-[#8187c9]",
    swatchClassName: "bg-[#8187c9]",
  },
  {
    value: "violet",
    label: "Violet",
    className: "text-[#7462ab] dark:text-[#9480c9]",
    swatchClassName: "bg-[#9480c9]",
  },
  {
    value: "purple",
    label: "Purple",
    className: "text-[#845ea5] dark:text-[#a27cc2]",
    swatchClassName: "bg-[#a27cc2]",
  },
  {
    value: "fuchsia",
    label: "Fuchsia",
    className: "text-[#92597f] dark:text-[#b07aa0]",
    swatchClassName: "bg-[#b07aa0]",
  },
  {
    value: "pink",
    label: "Pink",
    className: "text-[#a05472] dark:text-[#c17391]",
    swatchClassName: "bg-[#c17391]",
  },
  {
    value: "rose",
    label: "Rose",
    className: "text-[#a94e5f] dark:text-[#c86b7b]",
    swatchClassName: "bg-[#c86b7b]",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
