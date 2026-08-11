import * as Layer from "effect/Layer";

import type { McpCapability } from "./McpInvocationContext.ts";

/** A registered toolkit and the credential capability it requires. */
export interface McpToolkitRegistration<LayerInput> {
  readonly capability: McpCapability;
  readonly layer: Layer.Layer<never, never, LayerInput>;
}

export const makeMcpToolkitRegistration = <LayerInput>(
  capability: McpCapability,
  layer: Layer.Layer<never, never, LayerInput>,
): McpToolkitRegistration<LayerInput> => ({ capability, layer });

/** Compose capability-scoped registrations while retaining their service requirements. */
export const composeMcpToolkitRegistrations = <LayerInput>(
  registrations: readonly [
    McpToolkitRegistration<LayerInput>,
    ...Array<McpToolkitRegistration<LayerInput>>,
  ],
): Layer.Layer<never, never, LayerInput> => {
  const [first, ...rest] = registrations;
  return Layer.mergeAll(first.layer, ...rest.map(({ layer }) => layer));
};
