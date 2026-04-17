import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface CursorProviderShape extends ServerProviderShape {}

export class CursorProvider extends Context.Service<CursorProvider, CursorProviderShape>()(
  "t3/provider/Services/CursorProvider",
) {}
