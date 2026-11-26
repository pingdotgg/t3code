import type { ProjectIconOverride } from "@t3tools/contracts";
import * as Lucide from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { useResolveClassNames } from "uniwind";
import { projectIconColorClassNames } from "../lib/projectIcon";

const iconExports: Readonly<Partial<Record<`Lucide${string}`, LucideIcon>>> = Lucide;

export default function LucideProjectIcon(props: {
  readonly icon: Extract<ProjectIconOverride, { kind: "lucide" }>;
  readonly size: number;
  readonly fallback: ReactNode;
}) {
  const exportName = props.icon.name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const Icon = iconExports[`Lucide${exportName}`];
  const { color } = useResolveClassNames(projectIconColorClassNames(props.icon.color).text);

  return Icon ? <Icon size={props.size} color={color} /> : props.fallback;
}
