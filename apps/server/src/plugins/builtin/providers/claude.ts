import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

export type AdapterInfrastructure = ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;

export const layerAdapterInfrastructure = ClaudeAdapterV2.layerQueryRunner;
