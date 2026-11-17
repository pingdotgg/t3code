import { useEffect, useState } from "react";
import type { AgentPreset } from "@t3tools/shared/agentPresets";

const loadAgentPresets = () => import("./agentPresetBundle");

/** The built-in presets, from the bundle split out of the main chunk; null while it loads. */
export function useBuiltInAgentPresets() {
  const [presets, setPresets] = useState<ReadonlyArray<AgentPreset> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the lazily split preset bundle once.
  useEffect(() => {
    let live = true;
    loadAgentPresets().then(
      (bundle) => {
        if (live) setPresets(bundle.agentPresets);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return presets;
}
