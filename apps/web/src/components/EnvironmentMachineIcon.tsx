import type { EnvironmentMachineKind } from "@t3tools/contracts";
import {
  CloudIcon,
  LaptopIcon,
  MonitorIcon,
  ServerIcon,
  SquareTerminalIcon,
  type LucideProps,
} from "lucide-react";
import type { FunctionComponent, SVGProps } from "react";
import {
  AlpineLinuxIcon,
  AppleIcon,
  ArchLinuxIcon,
  DebianIcon,
  DockerIcon,
  FedoraIcon,
  LinuxIcon,
  LinuxMintIcon,
  NixOsIcon,
  OpenSuseIcon,
  RaspberryPiIcon,
  UbuntuIcon,
  WindowsIcon,
} from "./Icons";

function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="12" x="3" y="6" rx="2.5" />
      <circle cx="7.5" cy="12" r="1" fill="currentColor" stroke="none" />
    </LucideLike>
  );
}

function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </LucideLike>
  );
}

/** The shared Apple mark, padded to match the other OS marks. */
function MacOsIcon(props: SVGProps<SVGSVGElement>) {
  return <AppleIcon viewBox="-2 -2 28 28" {...props} />;
}

const ICON_BY_KIND: Record<EnvironmentMachineKind, FunctionComponent<LucideProps>> = {
  server: ServerIcon,
  cloud: CloudIcon,
  linux: LinuxIcon,
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
  "raspberry-pi": RaspberryPiIcon,
  docker: DockerIcon,
  macos: MacOsIcon,
  windows: WindowsIcon,
  wsl: SquareTerminalIcon,
  debian: DebianIcon,
  ubuntu: UbuntuIcon,
  fedora: FedoraIcon,
  arch: ArchLinuxIcon,
  mint: LinuxMintIcon,
  opensuse: OpenSuseIcon,
  nixos: NixOsIcon,
  alpine: AlpineLinuxIcon,
};

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
  "raspberry-pi": "Raspberry Pi",
  docker: "Docker",
  macos: "macOS",
  windows: "Windows",
  wsl: "WSL",
  debian: "Debian",
  ubuntu: "Ubuntu",
  fedora: "Fedora",
  arch: "Arch Linux",
  mint: "Linux Mint",
  opensuse: "openSUSE",
  nixos: "NixOS",
  alpine: "Alpine Linux",
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
