import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface ClaudeProviderShape extends ServerProviderShape {}

export class ClaudeProvider extends ServiceMap.Service<ClaudeProvider, ClaudeProviderShape>()(
  "t3/provider/Services/ClaudeProvider",
) {}
