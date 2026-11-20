import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { msg } from "gt-react";
import { CloudIcon, LaptopIcon, MonitorIcon, ServerIcon, type LucideProps } from "lucide-react";
import type { FunctionComponent } from "react";
import { connIcon } from "../icons/connIcon";
import { computerMiniGlyph, computerStudioGlyph } from "../icons/glyphs.generated";
import { LinuxIcon } from "./Icons";

const MacMiniIcon = connIcon("computer-mini", computerMiniGlyph);
const MacStudioIcon = connIcon("computer-studio", computerStudioGlyph);

const ICON_BY_KIND: Record<EnvironmentMachineKind, FunctionComponent<LucideProps>> = {
  server: ServerIcon,
  cloud: CloudIcon,
  linux: LinuxIcon,
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
};

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: msg("Server"),
  cloud: msg("Cloud VM"),
  linux: msg("Linux/WSL"),
  desktop: msg("Desktop"),
  laptop: msg("Laptop"),
  "mac-mini": msg("Mini PC"),
  "mac-studio": msg("Workstation"),
};

export function environmentMachineIcon(
  kind: EnvironmentMachineKind,
): FunctionComponent<LucideProps> {
  return ICON_BY_KIND[kind];
}

export function EnvironmentMachineIcon({
  kind,
  ...props
}: LucideProps & { readonly kind: EnvironmentMachineKind }) {
  const Icon = ICON_BY_KIND[kind];
  return <Icon {...props} />;
}
