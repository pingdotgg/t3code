import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

export class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "marcode/provider/Services/OpenCodeAdapter",
) {}
