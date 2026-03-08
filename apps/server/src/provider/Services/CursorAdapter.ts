import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CursorAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cursor";
}

export class CursorAdapter extends ServiceMap.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Services/CursorAdapter",
) {}
