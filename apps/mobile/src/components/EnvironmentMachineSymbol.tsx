import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { SymbolView, type AppSymbolName } from "./ui/AppSymbol";

// SF Symbols carries no OS or distribution marks besides Apple's, so those
// kinds share the closest generic glyph.
export const ENVIRONMENT_MACHINE_SYMBOLS = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
  "raspberry-pi": "cpu",
  docker: "shippingbox",
  macos: "apple.logo",
  windows: "pc",
  wsl: "terminal",
  debian: "terminal",
  ubuntu: "terminal",
  fedora: "terminal",
  arch: "terminal",
  mint: "terminal",
  opensuse: "terminal",
  nixos: "terminal",
  alpine: "terminal",
} as const satisfies Record<EnvironmentMachineKind, AppSymbolName>;

const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
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

export function EnvironmentMachineSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[props.kind]}
      name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
