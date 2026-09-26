import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ComponentProps } from "react";

import { AgentsPanel } from "../../components/AgentsPanel";

export type AgentsBindings = ComponentProps<typeof AgentsPanel>;

export function createAgentsExtension(
  useBindings: () => AgentsBindings,
): Extension<SurfaceRenderer> {
  function AgentsSurface() {
    const bindings = useBindings();
    return <AgentsPanel {...bindings} />;
  }

  return {
    manifest: {
      id: "t3.agents",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: "t3.agents/view",
          title: "Agents",
          placements: ["side-panel"],
          clients: ["web", "desktop"],
          scope: "thread",
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: "t3.agents/view",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: AgentsSurface }),
      },
    ],
  };
}
