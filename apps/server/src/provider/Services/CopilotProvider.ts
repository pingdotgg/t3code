import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface CopilotProviderShape extends ServerProviderShape {}

export class CopilotProvider extends Context.Service<CopilotProvider, CopilotProviderShape>()(
  "t3/provider/Services/CopilotProvider",
) {}
