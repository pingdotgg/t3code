import { CliRenderEvents, type TerminalCapabilities } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import * as React from "react";

/** Reactive view of OpenTUI's asynchronously-detected Kitty graphics capability. */
export function useKittyGraphicsSupport(): boolean {
  const renderer = useRenderer();
  const [supported, setSupported] = React.useState(renderer.capabilities?.kitty_graphics === true);

  React.useEffect(() => {
    const onCapabilities = (capabilities: TerminalCapabilities) => {
      setSupported(capabilities.kitty_graphics);
    };
    renderer.on(CliRenderEvents.CAPABILITIES, onCapabilities);
    return () => {
      renderer.off(CliRenderEvents.CAPABILITIES, onCapabilities);
    };
  }, [renderer]);

  return supported;
}
