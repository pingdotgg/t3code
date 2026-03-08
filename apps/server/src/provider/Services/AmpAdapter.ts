import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface AmpAdapterShape
  extends Omit<ProviderAdapterShape<ProviderAdapterError>, "provider"> {
  readonly provider: "amp";
}

export class AmpAdapter extends ServiceMap.Service<AmpAdapter, AmpAdapterShape>()(
  "t3/provider/Services/AmpAdapter",
) {}
