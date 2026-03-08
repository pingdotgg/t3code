import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiloAdapterShape
  extends Omit<ProviderAdapterShape<ProviderAdapterError>, "provider"> {
  readonly provider: "kilo";
}

export class KiloAdapter extends ServiceMap.Service<KiloAdapter, KiloAdapterShape>()(
  "t3/provider/Services/KiloAdapter",
) {}
