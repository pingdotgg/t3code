import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface ClaudeProviderShape extends ServerProviderShape {}

export class ClaudeProvider extends Context.Service<ClaudeProvider, ClaudeProviderShape>()(
  "t3/provider/Services/ClaudeProvider",
) {}
