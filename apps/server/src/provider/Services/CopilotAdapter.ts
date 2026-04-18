import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

export class CopilotAdapter extends Context.Service<CopilotAdapter, CopilotAdapterShape>()(
  "t3/provider/Services/CopilotAdapter",
) {}
