import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as Layer from "effect/Layer";

import * as ProviderHostLive from "../../../provider/ProviderHostLive.ts";

export const layerSupport = AcpRegistrySupport.layerFromHost.pipe(
  Layer.provide(ProviderHostLive.layer),
);
