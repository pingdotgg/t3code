import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface OpenCodeProviderShape extends ServerProviderShape {}

export class OpenCodeProvider extends Context.Service<OpenCodeProvider, OpenCodeProviderShape>()(
  "t3/provider/Services/OpenCodeProvider",
) {}
