import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { SFSymbol } from "expo-symbols";

import { SymbolView } from "./AppSymbol";

const SYMBOL_BY_KIND: Record<EnvironmentMachineKind, SFSymbol> = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
};

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mac mini",
  "mac-studio": "Mac Studio",
};

/** The glyph an environment wears in lists; SF Symbols on iOS, Tabler on Android. */
export function EnvironmentMachineSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[props.kind]}
      name={SYMBOL_BY_KIND[props.kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
