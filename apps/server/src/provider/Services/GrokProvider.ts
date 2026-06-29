import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface GrokProviderShape extends ServerProviderShape {}

export class GrokProvider extends Context.Service<GrokProvider, GrokProviderShape>()(
  "forma/provider/Services/GrokProvider",
) {}
