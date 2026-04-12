import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OllamaAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "ollama";
}

export class OllamaAdapter extends Context.Service<OllamaAdapter, OllamaAdapterShape>()(
  "t3/provider/Services/OllamaAdapter",
) {}
