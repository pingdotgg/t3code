import { CliRenderEvents } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { getKittyImageManager } from "@t3tools/opentui-image";
import * as React from "react";

/** Reactive view of OpenTUI's asynchronously-detected Kitty graphics capability. */
export function useKittyGraphicsSupport(): boolean {
  const renderer = useRenderer();
  const manager = getKittyImageManager(renderer);
  const [supported, setSupported] = React.useState(manager.isSupported);

  React.useEffect(() => {
    const onCapabilities = () => {
      setSupported(manager.isSupported);
    };
    renderer.on(CliRenderEvents.CAPABILITIES, onCapabilities);
    return () => {
      renderer.off(CliRenderEvents.CAPABILITIES, onCapabilities);
    };
  }, [manager, renderer]);

  return supported;
}
