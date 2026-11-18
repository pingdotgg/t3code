import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react-native";

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
  server: msg("Server", { $context: "machine type" }),
  cloud: msg("Cloud VM"),
  linux: msg("Linux"),
  desktop: msg("Desktop", { $context: "machine type" }),
  laptop: msg("Laptop"),
  "mac-mini": msg("Mini PC"),
  "mac-studio": msg("Workstation"),
  "raspberry-pi": msg("Raspberry Pi"),
  docker: msg("Docker"),
  macos: msg("macOS"),
  windows: msg("Windows"),
  wsl: msg("WSL"),
  debian: msg("Debian"),
  ubuntu: msg("Ubuntu"),
  fedora: msg("Fedora"),
  arch: msg("Arch Linux"),
  mint: msg("Linux Mint"),
  opensuse: msg("openSUSE"),
  nixos: msg("NixOS"),
  alpine: msg("Alpine Linux"),
};

export function EnvironmentMachineSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const m = useMessages();
  return (
    <SymbolView
      accessibilityLabel={m(ENVIRONMENT_MACHINE_KIND_LABELS[props.kind])}
      name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
