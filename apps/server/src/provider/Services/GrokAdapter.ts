import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GrokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "grok";
}

export class GrokAdapter extends Context.Service<GrokAdapter, GrokAdapterShape>()(
  "forma/provider/Services/GrokAdapter",
) {}
